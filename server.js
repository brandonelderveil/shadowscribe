import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { WebSocketServer } from "ws";
import selfsigned from "selfsigned";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const TLS_CA_PATH = process.env.TLS_CA_PATH;
const ALLOW_INSECURE = process.env.ALLOW_INSECURE === "true";
const USE_TLS = !ALLOW_INSECURE;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const DEV_CERT_DIR = path.join(__dirname, "certs");
const DEV_CERT_PATH = path.join(DEV_CERT_DIR, "server.crt");
const DEV_KEY_PATH = path.join(DEV_CERT_DIR, "server.key");

const rooms = new Map();
const invalidRooms = new Set();

const shouldAutoGenerateTls = USE_TLS && !TLS_CERT_PATH && !TLS_KEY_PATH;

if (USE_TLS && !shouldAutoGenerateTls && (!TLS_CERT_PATH || !TLS_KEY_PATH)) {
    process.exit(1);
}
const requestHandler = async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        let pathname = decodeURIComponent(url.pathname);

        if (pathname === "/") {
            pathname = "/index.html";
        }

        const absolute = path.normalize(path.join(publicDir, pathname));
        if (!absolute.startsWith(publicDir)) {
            return sendError(res, 403, "Forbidden");
        }

        let stats;
        try {
            stats = await stat(absolute);
        } catch (_) {
            return sendError(res, 404, "Not Found");
        }

        let filePath = absolute;
        if (stats.isDirectory()) {
            filePath = path.join(absolute, "index.html");
            stats = await stat(filePath);
        }

        const securityHeaders = buildSecurityHeaders();
        const headers = {
            "Content-Type": getContentType(filePath),
            "Content-Length": stats.size,
            ...securityHeaders
        };

        res.writeHead(200, headers);
        createReadStream(filePath).pipe(res);
    } catch (_) {
        sendError(res, 500, "Server Error");
    }
};


function sendError(res, statusCode, message) {
    const headers = {
        "Content-Type": "text/plain; charset=utf-8",
        ...buildSecurityHeaders()
    };
    res.writeHead(statusCode, headers);
    res.end(message);
}

function buildSecurityHeaders() {
    const connectSrc = USE_TLS ? "'self' wss:" : "'self' ws: wss:";
    const headers = {
        "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self'; connect-src ${connectSrc}; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`,
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "Cross-Origin-Resource-Policy": "same-site"
    };
    if (USE_TLS) {
        headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains; preload";
    }
    return headers;
}

function ensureDevCertificate() {
    if (!existsSync(DEV_CERT_DIR)) {
        mkdirSync(DEV_CERT_DIR, { recursive: true });
    }

    const hasExisting = existsSync(DEV_CERT_PATH) && existsSync(DEV_KEY_PATH);

    if (!hasExisting) {
        const attrs = [{ name: "commonName", value: "localhost" }];
        const pems = selfsigned.generate(attrs, {
            days: 365,
            keySize: 2048,
            algorithm: "sha256",
            extensions: [
                { name: "basicConstraints", cA: false },
                { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
                { name: "extKeyUsage", serverAuth: true, clientAuth: true },
                {
                    name: "subjectAltName",
                    altNames: [
                        { type: 2, value: "localhost" },
                        { type: 7, ip: "127.0.0.1" },
                        { type: 7, ip: "::1" }
                    ]
                }
            ]
        });

        writeFileSync(DEV_KEY_PATH, pems.private, { mode: 0o600 });
        writeFileSync(DEV_CERT_PATH, pems.cert);
    }

    return {
        key: readFileSync(DEV_KEY_PATH),
        cert: readFileSync(DEV_CERT_PATH)
    };
}

function resolveConfigPath(value) {
    if (!value) {
        return null;
    }
    return path.isAbsolute(value) ? value : path.join(__dirname, value);
}

function loadTlsOptions() {
    const options = {
        key: readFileSync(resolveConfigPath(TLS_KEY_PATH)),
        cert: readFileSync(resolveConfigPath(TLS_CERT_PATH))
    };

    if (TLS_CA_PATH) {
        options.ca = TLS_CA_PATH.split(path.delimiter)
            .map(segment => segment.trim())
            .filter(Boolean)
            .map(segment => readFileSync(resolveConfigPath(segment)));
    }

    return options;
}

let server;

if (USE_TLS) {
    try {
        const tlsOptions = shouldAutoGenerateTls ? ensureDevCertificate() : loadTlsOptions();
        server = https.createServer(tlsOptions, requestHandler);
    } catch (_) {
        process.exit(1);
    }
} else {
    server = http.createServer(requestHandler);
}

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, ws => {
        wss.emit("connection", ws, request);
    });
});

wss.on("connection", ws => {
    ws.isAlive = true;
    ws.meta = { roomId: null, userId: null };

    ws.on("pong", () => {
        ws.isAlive = true;
    });

    ws.on("message", data => {
        try {
            const payload = JSON.parse(data.toString());
            handleClientMessage(ws, payload);
        } catch (_) {
            ws.send(JSON.stringify({ type: "error", error: "Invalid payload." }));
        }
    });

    ws.on("close", () => {
        if (ws.meta.roomId && ws.meta.userId) {
            removeClient(ws.meta.roomId, ws.meta.userId);
        }
    });

    ws.on("error", error => {
    });
});

const heartbeat = setInterval(() => {
    wss.clients.forEach(socket => {
        if (socket.isAlive === false) {
            return socket.terminate();
        }
        socket.isAlive = false;
        socket.ping();
    });
}, 30000);

wss.on("close", () => clearInterval(heartbeat));

function handleClientMessage(ws, message) {
    switch (message.type) {
        case "join":
            handleJoin(ws, message);
            break;
        case "message":
            handleChatMessage(ws, message);
            break;
        default:
            ws.send(JSON.stringify({ type: "error", error: "Unsupported message type." }));
    }
}

function handleJoin(ws, message) {
    const { roomId, userId, keySalt } = message;
    if (!roomId || !uuidPattern.test(roomId)) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid room identifier." }));
        ws.close(1008, "Invalid room");
        return;
    }
    if (!userId || !uuidPattern.test(userId)) {
        ws.send(JSON.stringify({ type: "error", error: "Invalid user identifier." }));
        ws.close(1008, "Invalid user");
        return;
    }
    if (typeof keySalt !== "string" || !keySalt.length) {
        ws.send(JSON.stringify({ type: "error", error: "Missing key salt." }));
        ws.close(1008, "Missing key salt");
        return;
    }
    if (invalidRooms.has(roomId)) {
        ws.send(JSON.stringify({ type: "error", error: "Room is no longer available." }));
        ws.close(1008, "Room invalid");
        return;
    }

    const now = Date.now();
    let room = rooms.get(roomId);
    if (room && now - room.createdAt >= ROOM_TTL_MS) {
        expireRoom(roomId, "24h");
        ws.send(JSON.stringify({ type: "error", error: "Room expired." }));
        ws.close(1008, "Room expired");
        return;
    }

    if (!room) {
        room = createRoom(roomId);
    }

    if (room.clients.has(userId)) {
        ws.send(JSON.stringify({ type: "error", error: "User already connected." }));
        ws.close(1008, "Duplicate user");
        return;
    }

    ws.meta = { roomId, userId };
    const clientRecord = { socket: ws, userId, keySalt, joinedAt: now };
    room.clients.set(userId, clientRecord);

    const usersPayload = Array.from(room.clients.values()).map(client => ({
        userId: client.userId,
        keySalt: client.keySalt
    }));

    ws.send(JSON.stringify({
        type: "joined",
        roomId,
        expiresAt: new Date(room.createdAt + ROOM_TTL_MS).toISOString(),
        users: usersPayload
    }));

    broadcast(roomId, {
        type: "user-joined",
        roomId,
        userId,
        keySalt
    }, userId);
}

function handleChatMessage(ws, message) {
    const { roomId, userId } = ws.meta;
    if (!roomId || !userId) {
        ws.send(JSON.stringify({ type: "error", error: "Join a room before sending messages." }));
        return;
    }
    if (message.roomId !== roomId || message.userId !== userId) {
        ws.send(JSON.stringify({ type: "error", error: "Identity mismatch." }));
        return;
    }

    const room = rooms.get(roomId);
    if (!room) {
        ws.send(JSON.stringify({ type: "error", error: "Room unavailable." }));
        ws.close(1008, "Room invalid");
        return;
    }

    const { payload } = message;
    if (!payload || typeof payload.ciphertext !== "string" || typeof payload.iv !== "string") {
        ws.send(JSON.stringify({ type: "error", error: "Invalid message payload." }));
        return;
    }

    broadcast(roomId, {
        type: "message",
        roomId,
        userId,
        payload: {
            ciphertext: payload.ciphertext,
            iv: payload.iv,
            timestamp: payload.timestamp || new Date().toISOString()
        }
    });
}

function createRoom(roomId) {
    const createdAt = Date.now();
    const room = {
        roomId,
        createdAt,
        clients: new Map(),
        expiryTimer: setTimeout(() => expireRoom(roomId, "24h"), ROOM_TTL_MS)
    };
    rooms.set(roomId, room);
    return room;
}

function expireRoom(roomId, reason) {
    const room = rooms.get(roomId);
    if (!room) {
        return;
    }
    rooms.delete(roomId);
    invalidRooms.add(roomId);
    clearTimeout(room.expiryTimer);
    for (const client of room.clients.values()) {
        try {
            client.socket.send(JSON.stringify({ type: "room-expired", reason }));
            client.socket.close(4001, "Room expired");
        } catch (_) {}
    }
}

function removeClient(roomId, userId) {
    const room = rooms.get(roomId);
    if (!room) {
        return;
    }
    room.clients.delete(userId);
    broadcast(roomId, { type: "user-left", roomId, userId });
    if (room.clients.size === 0) {
        invalidateRoom(roomId);
    }
}

function invalidateRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) {
        invalidRooms.add(roomId);
        return;
    }
    rooms.delete(roomId);
    invalidRooms.add(roomId);
    clearTimeout(room.expiryTimer);
}

function broadcast(roomId, data, excludeUserId) {
    const room = rooms.get(roomId);
    if (!room) {
        return;
    }
    const payload = JSON.stringify(data);
    for (const client of room.clients.values()) {
        if (client.userId === excludeUserId) {
            continue;
        }
        try {
            client.socket.send(payload);
        } catch (_) {}
    }
}

function getContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    switch (ext) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".js":
            return "application/javascript; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".json":
            return "application/json; charset=utf-8";
        case ".png":
            return "image/png";
        case ".jpg":
        case ".jpeg":
            return "image/jpeg";
        case ".svg":
            return "image/svg+xml";
        default:
            return "application/octet-stream";
    }
}

server.listen(PORT);





















