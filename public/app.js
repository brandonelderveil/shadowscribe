const encoder = new TextEncoder();
const decoder = new TextDecoder();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const elements = {
    landingView: document.getElementById("landing-view"),
    chatView: document.getElementById("chat-view"),
    joinForm: document.getElementById("join-form"),
    roomInput: document.getElementById("room-id"),
    generateRoom: document.getElementById("generate-room"),
    passphraseInput: document.getElementById("passphrase"),
    messageForm: document.getElementById("message-form"),
    messageInput: document.getElementById("message-input"),
    sidebar: document.getElementById("sidebar"),
    sidebarToggle: document.getElementById("sidebar-toggle"),
    sidebarToggleMain: document.getElementById("sidebar-toggle-main"),
    sidebarBackdrop: document.getElementById("sidebar-backdrop"),
    disconnect: document.getElementById("disconnect"),
    messageContainer: document.getElementById("message-container"),
    userList: document.getElementById("user-list"),
    roomLabel: document.getElementById("room-label"),
    roomExpiry: document.getElementById("room-expiry"),
    connectionStatus: document.getElementById("connection-status"),
    modal: document.getElementById("passphrase-modal"),
    modalUser: document.getElementById("modal-user"),
    modalClose: document.getElementById("modal-close"),
    unlockForm: document.getElementById("unlock-form"),
    unlockPhrase: document.getElementById("unlock-phrase"),
    unlockNickname: document.getElementById("unlock-nickname"),
    unlockFeedback: document.getElementById("unlock-feedback"),
    messageTemplate: document.getElementById("message-template")
};

const mobileQuery = window.matchMedia ? window.matchMedia("(max-width: 900px)") : {
    matches: false,
    addEventListener: null,
    addListener: null
};

const state = {
    ws: null,
    connected: false,
    roomId: null,
    expiresAt: null,
    myUserId: null,
    myKey: null,
    mySalt: null,
    passphrase: null,
    users: new Map(),
    messages: new Map(),
    nicknames: new Map(),
    pendingUnlockUser: null
};

init();
function requireSecureTransport() {
    const { protocol, hostname } = window.location;
    if (LOCAL_HOSTS.has(hostname)) {
        return;
    }
    if (protocol !== "https:" || !window.isSecureContext) {
        throw new Error("Secure transport required. Serve ShadowScribe over HTTPS.");
    }
}


function init() {
    elements.joinForm.addEventListener("submit", onJoinSubmit);
    elements.generateRoom.addEventListener("click", onGenerateRoom);
    elements.messageForm.addEventListener("submit", onMessageSubmit);
    elements.disconnect.addEventListener("click", () => disconnect("manual"));
    if (elements.sidebarToggle) {
        elements.sidebarToggle.addEventListener("click", toggleSidebar);
    }
    if (elements.sidebarToggleMain) {
        elements.sidebarToggleMain.addEventListener("click", toggleSidebar);
    }
    if (elements.sidebarBackdrop) {
        elements.sidebarBackdrop.addEventListener("click", () => closeSidebar());
    }
    elements.modalClose.addEventListener("click", closeModal);
    elements.unlockForm.addEventListener("submit", onUnlockSubmit);
    window.addEventListener("beforeunload", () => {
        if (state.ws && state.connected) {
            state.ws.close(1001, "page closed");
        }
    });

    if (typeof mobileQuery.addEventListener === "function") {
        mobileQuery.addEventListener("change", handleViewportChange);
    } else if (typeof mobileQuery.addListener === "function") {
        mobileQuery.addListener(handleViewportChange);
    }
    handleViewportChange();

    const params = new URLSearchParams(window.location.search);
    const roomFromQuery = params.get("room");
    if (roomFromQuery && uuidPattern.test(roomFromQuery)) {
        elements.roomInput.value = roomFromQuery;
    }
}

function onGenerateRoom() {
    const id = crypto.randomUUID();
    elements.roomInput.value = id;
}

async function onJoinSubmit(event) {
    event.preventDefault();
    const roomId = elements.roomInput.value.trim();
    const phrase = elements.passphraseInput.value.trim();

    if (!uuidPattern.test(roomId)) {
        elements.roomInput.setCustomValidity("Must be a valid UUID");
        elements.roomInput.reportValidity();
        return;
    }

    elements.roomInput.setCustomValidity("");

    if (phrase.length < 4) {
        elements.passphraseInput.setCustomValidity("Phrase must be at least 4 characters");
        elements.passphraseInput.reportValidity();
        return;
    }

    elements.passphraseInput.setCustomValidity("");

    elements.joinForm.querySelectorAll("input, button").forEach(el => el.disabled = true);
    try {
        await connect(roomId, phrase);
    } catch (error) {
        console.error("Failed to connect", error);
        showLanding();
        alert("Unable to connect to room. " + (error?.message || "Please try again."));
    } finally {
        elements.joinForm.querySelectorAll("input, button").forEach(el => el.disabled = false);
    }
}

async function connect(roomId, phrase) {
    if (state.ws) {
        state.ws.close();
    }

    requireSecureTransport();
    const saltBytes = crypto.getRandomValues(new Uint8Array(16));
    const salt = arrayBufferToBase64(saltBytes.buffer);
    const key = await deriveKey(phrase, salt);
    const userId = crypto.randomUUID();

    Object.assign(state, {
        roomId,
        passphrase: phrase,
        myUserId: userId,
        myKey: key,
        mySalt: salt,
        users: new Map(),
        messages: new Map(),
        nicknames: new Map(),
        pendingUnlockUser: null
    });

    registerUser({ userId, keySalt: salt, unlocked: true, key });
    setConnectionStatus("Connecting?");
    showChat();
    updateRoomLabel(roomId);

    const url = buildWebSocketUrl();
    const ws = new WebSocket(url);
    state.ws = ws;

    ws.addEventListener("open", () => {
        setConnectionStatus("Connected");
        ws.send(JSON.stringify({
            type: "join",
            roomId,
            userId,
            keySalt: salt
        }));
    });

    ws.addEventListener("message", event => {
        try {
            const payload = JSON.parse(event.data);
            handleServerMessage(payload);
        } catch (error) {
            console.error("Invalid message", event.data, error);
        }
    });

    ws.addEventListener("close", event => {
        const reason = event.reason || (event.wasClean ? "Connection closed" : "Connection lost");
        disconnect("closed", reason);
    });

    ws.addEventListener("error", () => {
        setConnectionStatus("Error");
    });

    const params = new URLSearchParams(window.location.search);
    params.set("room", roomId);
    history.replaceState(null, "", `${window.location.pathname}?${params}`);
}

function handleServerMessage(message) {
    switch (message.type) {
        case "joined":
            onJoined(message);
            break;
        case "user-joined":
            onUserJoined(message);
            break;
        case "user-left":
            onUserLeft(message);
            break;
        case "message":
            onIncomingMessage(message);
            break;
        case "room-expired":
            onRoomExpired(message);
            break;
        case "error":
            onServerError(message);
            break;
        default:
            console.warn("Unhandled message type", message);
    }
}

function onJoined(message) {
    state.connected = true;
    state.expiresAt = message.expiresAt ? new Date(message.expiresAt) : null;
    updateExpiryLabel();

    const { users } = message;
    if (Array.isArray(users)) {
        users.forEach(user => {
            if (user.userId === state.myUserId) {
                return;
            }
            registerUser({ userId: user.userId, keySalt: user.keySalt, unlocked: false, key: null });
        });
    }
}

function onUserJoined(message) {
    if (!message.userId || message.userId === state.myUserId) {
        return;
    }
    registerUser({ userId: message.userId, keySalt: message.keySalt, unlocked: false, key: null });
    appendSystemMessage(`${message.userId} connected.`);
}

function onUserLeft(message) {
    const { userId } = message;
    if (!userId) {
        return;
    }
    state.users.delete(userId);
    renderUserList();
    appendSystemMessage(`${userId} left the room.`);
}

function onIncomingMessage(message) {
    const { userId, payload } = message;
    if (!userId || !payload) {
        return;
    }

    const record = {
        id: crypto.randomUUID(),
        senderId: userId,
        ciphertext: payload.ciphertext,
        iv: payload.iv,
        timestamp: payload.timestamp || new Date().toISOString(),
        plaintext: null,
        element: null
    };

    state.messages.set(record.id, record);
    renderMessage(record);

    const user = state.users.get(userId);
    if (user?.key) {
        decryptMessage(record, user.key).catch(() => {
            // Swallow; will remain encrypted.
        });
    }
}

function onRoomExpired(message) {
    appendSystemMessage(message.reason === "24h" ? "Room expired after 24 hours." : "Room closed.");
    disconnect("expired", "Room expired");
}

function onServerError(message) {
    const detail = message.error || "Unexpected server error.";
    appendSystemMessage(`Server error: ${detail}`);
}

function appendSystemMessage(text) {
    const record = {
        id: crypto.randomUUID(),
        senderId: "system",
        timestamp: new Date().toISOString(),
        plaintext: text,
        ciphertext: null,
        iv: null,
        element: null
    };
    renderMessage(record, true);
}

function renderMessage(record, forcePlain = false) {
    const template = elements.messageTemplate.content.firstElementChild.cloneNode(true);
    const senderLabel = template.querySelector(".sender");
    const timestampLabel = template.querySelector(".timestamp");
    const body = template.querySelector(".body");

    template.dataset.messageId = record.id;
    template.dataset.sender = record.senderId;

    if (record.senderId === state.myUserId) {
        template.classList.add("self");
    } else if (record.senderId === "system") {
        template.classList.add("system");
    }

    if (record.senderId === "system") {
        senderLabel.textContent = "System";
    } else {
        senderLabel.textContent = getDisplayLabel(record.senderId);
    }

    timestampLabel.textContent = formatTimestamp(record.timestamp);

    if (forcePlain || record.plaintext) {
        body.classList.remove("encrypted");
        body.textContent = record.plaintext;
    } else if (record.ciphertext) {
        body.classList.add("encrypted");
        body.textContent = record.ciphertext;
    } else {
        body.textContent = "";
    }

    record.element = template;
    elements.messageContainer.appendChild(template);
    elements.messageContainer.scrollTop = elements.messageContainer.scrollHeight;
}

async function onMessageSubmit(event) {
    event.preventDefault();
    if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
        appendSystemMessage("Not connected.");
        return;
    }
    const text = elements.messageInput.value.trim();
    if (!text) {
        return;
    }

    elements.messageInput.value = "";
    try {
        const encrypted = await encryptText(text, state.myKey);
        const payload = {
            ciphertext: encrypted.ciphertext,
            iv: encrypted.iv,
            timestamp: new Date().toISOString()
        };
        state.ws.send(JSON.stringify({
            type: "message",
            roomId: state.roomId,
            userId: state.myUserId,
            payload
        }));
    } catch (error) {
        console.error("Failed to encrypt or send message", error);
        appendSystemMessage("Failed to send message.");
    }
}

function toggleSidebar(forceState) {
    if (forceState instanceof Event) {
        forceState.preventDefault();
    }
    if (!elements.sidebar) {
        return;
    }
    const shouldOpen = typeof forceState === "boolean"
        ? forceState
        : !elements.sidebar.classList.contains("open");

    const isMobile = isMobileViewport();

    if (shouldOpen) {
        elements.sidebar.classList.add("open");
        if (isMobile) {
            document.body.classList.add("sidebar-open");
            elements.sidebarBackdrop?.classList.add("active");
        } else {
            document.body.classList.remove("sidebar-open");
            elements.sidebarBackdrop?.classList.remove("active");
        }
    } else {
        elements.sidebar.classList.remove("open");
        document.body.classList.remove("sidebar-open");
        elements.sidebarBackdrop?.classList.remove("active");
    }
}

function closeSidebar() {
    toggleSidebar(false);
}

function openSidebar() {
    toggleSidebar(true);
}

function isMobileViewport() {
    return mobileQuery.matches;
}

function handleViewportChange() {
    if (!isMobileViewport()) {
        elements.sidebar?.classList.remove("open");
        document.body.classList.remove("sidebar-open");
        elements.sidebarBackdrop?.classList.remove("active");
    } else if (!elements.sidebar?.classList.contains("open")) {
        elements.sidebarBackdrop?.classList.remove("active");
    }
}

function showLanding() {
    closeSidebar();
    elements.landingView.classList.remove("hidden");
    elements.chatView.classList.add("hidden");
    elements.connectionStatus.textContent = "Offline";
    elements.messageContainer.innerHTML = "";
    elements.userList.innerHTML = "";
    handleViewportChange();
}

function showChat() {
    elements.landingView.classList.add("hidden");
    elements.chatView.classList.remove("hidden");
    elements.messageContainer.innerHTML = "";
    closeSidebar();
    renderUserList();
    handleViewportChange();
}

function updateRoomLabel(roomId) {
    elements.roomLabel.textContent = roomId;
}

function updateExpiryLabel() {
    if (!state.expiresAt) {
        elements.roomExpiry.textContent = "";
        return;
    }
    elements.roomExpiry.textContent = `Expires: ${state.expiresAt.toLocaleString()}`;
}

function setConnectionStatus(status) {
    elements.connectionStatus.textContent = status;
}

function registerUser({ userId, keySalt, unlocked, key }) {
    const existing = state.users.get(userId);
    const nickname = existing?.nickname ?? state.nicknames.get(userId) ?? null;
    state.users.set(userId, {
        userId,
        keySalt,
        unlocked,
        key: key || existing?.key || null,
        nickname
    });
    if (nickname !== null) {
        state.nicknames.set(userId, nickname);
    }
    renderUserList();
}

function renderUserList() {
    elements.userList.innerHTML = "";
    state.users.forEach(user => {
        const item = document.createElement("li");
        const isSelf = user.userId === state.myUserId;
        item.textContent = getDisplayLabel(user.userId, { includeSelfSuffix: true });
        item.title = user.nickname ? `${user.nickname} | ${user.userId}` : user.userId;
        if (isSelf) {
            item.classList.add("self");
        }
        if (user.unlocked) {
            item.classList.add("unlocked");
        }
        if (!isSelf) {
            item.addEventListener("click", () => {
                if (isMobileViewport()) {
                    closeSidebar();
                }
                openUnlockModal(user.userId);
            });
        }
        elements.userList.appendChild(item);
    });
}

function openUnlockModal(userId) {
    if (isMobileViewport()) {
        closeSidebar();
    }
    state.pendingUnlockUser = userId;
    const user = state.users.get(userId);
    if (!user) {
        return;
    }
    elements.modalUser.textContent = `Unlock messages from ${userId}`;
    elements.unlockPhrase.value = "";
    elements.unlockNickname.value = user.nickname || "";
    elements.unlockFeedback.textContent = "";
    elements.unlockFeedback.removeAttribute("style");
    elements.modal.classList.remove("hidden");
    elements.unlockPhrase.focus();
}

function closeModal() {
    state.pendingUnlockUser = null;
    elements.modal.classList.add("hidden");
    elements.unlockPhrase.value = "";
    elements.unlockNickname.value = "";
    elements.unlockFeedback.textContent = "";
    elements.unlockFeedback.removeAttribute("style");
}

async function onUnlockSubmit(event) {
    event.preventDefault();
    const userId = state.pendingUnlockUser;
    if (!userId) {
        closeModal();
        return;
    }
    const user = state.users.get(userId);
    if (!user) {
        closeModal();
        return;
    }

    const phrase = elements.unlockPhrase.value.trim();
    const nicknameRaw = elements.unlockNickname.value.trim();
    const nickname = nicknameRaw.length ? nicknameRaw : null;

    elements.unlockFeedback.textContent = "";
    elements.unlockFeedback.removeAttribute("style");

    if (phrase && phrase.length < 4) {
        elements.unlockFeedback.style.color = "var(--danger)";
        elements.unlockFeedback.textContent = "Phrase must be at least 4 characters.";
        return;
    }

    const previousNickname = user.nickname ?? null;
    let shouldRerenderUsers = false;
    const successMessages = [];
    let unlockedAny = false;

    if (nickname !== previousNickname) {
        user.nickname = nickname;
        shouldRerenderUsers = true;
        if (nickname === null) {
            state.nicknames.delete(userId);
            successMessages.push("Nickname cleared.");
        } else {
            state.nicknames.set(userId, nickname);
            successMessages.push("Nickname saved.");
        }
        updateMessagesForUser(userId);
    }

    if (phrase) {
        try {
            const key = await deriveKey(phrase, user.keySalt);
            const userMessages = Array.from(state.messages.values()).filter(msg => msg.senderId === userId && msg.ciphertext);
            for (const msg of userMessages) {
                await decryptMessage(msg, key);
                unlockedAny = true;
            }
            user.key = key;
            user.unlocked = true;
            shouldRerenderUsers = true;
            successMessages.push(unlockedAny ? "Messages unlocked." : "Phrase stored. Messages will decrypt automatically.");
        } catch (error) {
            console.warn("Failed to unlock", error);
            elements.unlockFeedback.style.color = "var(--danger)";
            elements.unlockFeedback.textContent = "Incorrect phrase.";
            return;
        }
    }

    if (shouldRerenderUsers) {
        renderUserList();
    }

    if (successMessages.length === 0) {
        elements.unlockFeedback.style.color = "var(--muted)";
        elements.unlockFeedback.textContent = "No changes made.";
        return;
    }

    elements.unlockFeedback.style.color = "var(--success)";
    elements.unlockFeedback.textContent = successMessages.join(" ");
    setTimeout(closeModal, 1200);
}

async function encryptText(plaintext, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = encoder.encode(plaintext);
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
    return {
        ciphertext: arrayBufferToBase64(ciphertext),
        iv: arrayBufferToBase64(iv.buffer)
    };
}

async function decryptMessage(record, key) {
    if (!record.ciphertext || !record.iv) {
        return;
    }
    const ciphertext = base64ToArray(record.ciphertext);
    const iv = base64ToArray(record.iv);
    const plaintextBuffer = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    record.plaintext = decoder.decode(plaintextBuffer);
    if (record.element) {
        const body = record.element.querySelector(".body");
        body.classList.remove("encrypted");
        body.textContent = record.plaintext;
    }
}

function disconnect(reason, detail) {
    if (state.ws) {
        try {
            state.ws.close();
        } catch (_) {
            // ignore
        }
    }
    state.ws = null;
    state.connected = false;
    state.roomId = null;
    state.users.clear();
    state.messages.clear();
    state.nicknames.clear();
    setConnectionStatus(reason === "manual" ? "Disconnected" : "Offline");
    showLanding();
    if (detail && reason !== "manual") {
        alert(detail);
    }
}

function buildWebSocketUrl() {
    const { protocol, hostname, port } = window.location;
    const isLocal = LOCAL_HOSTS.has(hostname);
    if (protocol !== "https:" && !isLocal) {
        throw new Error("Secure context required for WebSocket connections.");
    }
    const wsProtocol = protocol === "https:" ? "wss:" : "ws:";
    const base = `${wsProtocol}//${hostname}${port ? `:${port}` : ""}`;
    return `${base}/ws`;
}

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToArray(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

async function deriveKey(phrase, saltBase64) {
    const salt = base64ToArray(saltBase64);
    const material = await crypto.subtle.importKey(
        "raw",
        encoder.encode(phrase),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
    );
    return crypto.subtle.deriveKey(
        {
            name: "PBKDF2",
            salt,
            iterations: 250000,
            hash: "SHA-256"
        },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]
    );
}

function updateMessagesForUser(userId) {
    state.messages.forEach(record => {
        if (record.senderId !== userId || !record.element) {
            return;
        }
        const senderLabel = record.element.querySelector(".sender");
        if (senderLabel) {
            senderLabel.textContent = getDisplayLabel(userId);
        }
    });
}

function getDisplayLabel(userId, options = {}) {
    const { includeSelfSuffix = false } = options;
    if (!userId) {
        return "";
    }
    if (userId === "system") {
        return "System";
    }
    if (userId === state.myUserId) {
        return includeSelfSuffix ? `${userId} (you)` : "You";
    }
    const user = state.users.get(userId);
    if (user?.nickname) {
        return `${user.nickname} (${userId})`;
    }
    return userId;
}

function formatTimestamp(timestamp) {
    try {
        return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch (_) {
        return "";
    }
}
