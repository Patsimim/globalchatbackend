// sockets/socketHandler.js - Enhanced version with better organization
const { authenticateSocket } = require("../middleware/auth");
const User = require("../models/User");
const ChatRoom = require("../models/ChatRoom");
const { Message } = require("../models/Message");

// Store connected users and their metadata
const connectedUsers = new Map();
const roomUsers = new Map(); // Track users in specific rooms

// Configuration constants
const CONFIG = {
  MESSAGE_MAX_LENGTH: 2000,
  CLEANUP_INTERVAL: 60000, // 1 minute
  STATS_INTERVAL: 300000, // 5 minutes
  OFFLINE_THRESHOLD: 5 * 60 * 1000, // 5 minutes
  MAX_ROOMS_PER_USER: 50,
  RATE_LIMIT: {
    WINDOW: 60000, // 1 minute
    MAX_MESSAGES: 30,
  },
};

// Rate limiting store
const rateLimitStore = new Map();

/**
 * Main socket handler function
 */
function socketHandler(io) {
  console.log("🔌 WebSocket handler initialized");

  // Authentication middleware
  io.use(authenticateSocket);

  io.on("connection", (socket) => handleConnection(io, socket));

  // Setup periodic tasks
  setupPeriodicTasks(io);

  console.log("✅ WebSocket handlers set up successfully");

  // Return utility functions
  return {
    broadcastOnlineUsers: () => broadcastOnlineUsers(io),
    sendToUser: (userId, event, data) => sendToUser(io, userId, event, data),
    getOnlineUsersCount: () => connectedUsers.size,
    getRoomUsersCount: (roomId) => roomUsers.get(roomId)?.size || 0,
    connectedUsers,
    roomUsers,
    kickUser: (userId, reason) => kickUser(io, userId, reason),
    broadcastToRoom: (roomId, event, data) => io.to(roomId).emit(event, data),
  };
}

/**
 * Handle new socket connection
 */
async function handleConnection(io, socket) {
  try {
    const { userId, user } = socket;

    console.log(
      `👤 User connected: ${user.firstName} ${user.lastName} (${userId})`
    );

    // Initialize user session
    await initializeUserSession(socket, user);

    // Setup event handlers
    setupEventHandlers(io, socket);

    // Join user to their rooms
    await joinUserRooms(socket, userId);

    // Broadcast updates
    await broadcastUserJoined(io, socket, user);
  } catch (error) {
    console.error("Error in socket connection handler:", error);
    socket.emit("error", { message: "Connection setup failed" });
    socket.disconnect();
  }
}

/**
 * Initialize user session data
 */
async function initializeUserSession(socket, user) {
  const userId = socket.userId;

  // Set user online
  await user.setOnline(socket.id);

  // Store user connection
  connectedUsers.set(userId, {
    socketId: socket.id,
    user: user.getChatProfile(),
    connectedAt: new Date(),
    messageCount: 0,
    lastActivity: new Date(),
  });

  // Initialize rate limiting
  rateLimitStore.set(userId, {
    messages: [],
    lastReset: Date.now(),
  });
}

/**
 * Setup all event handlers for a socket
 */
function setupEventHandlers(io, socket) {
  // Message handlers
  socket.on("send_world_message", (data) =>
    handleWorldMessage(io, socket, data)
  );
  socket.on("send_group_message", (data) =>
    handleGroupMessage(io, socket, data)
  );
  socket.on("send_private_message", (data) =>
    handlePrivateMessage(io, socket, data)
  );

  // Typing indicators
  socket.on("typing_start", (data) => handleTypingStart(socket, data));
  socket.on("typing_stop", (data) => handleTypingStop(socket, data));

  // Room management
  socket.on("join_group", (data) => handleJoinGroup(socket, data));
  socket.on("leave_group", (data) => handleLeaveGroup(socket, data));

  // Message status
  socket.on("message_read", (data) => handleMessageRead(io, socket, data));
  socket.on("message_delivered", (data) =>
    handleMessageDelivered(io, socket, data)
  );

  // Connection management
  socket.on("disconnect", () => handleDisconnect(io, socket));
  socket.on("ping", () => socket.emit("pong", { timestamp: Date.now() }));

  // User status
  socket.on("set_status", (data) => handleSetStatus(io, socket, data));
  socket.on("get_room_users", (data) => handleGetRoomUsers(socket, data));
}

/**
 * Handle world chat messages with enhanced validation
 */
async function handleWorldMessage(io, socket, data) {
  try {
    const { userId, user } = socket;
    const { content } = data.message || data;

    // Rate limiting check
    if (!checkRateLimit(userId)) {
      socket.emit("error", {
        message: "Too many messages. Please slow down.",
        type: "RATE_LIMIT",
      });
      return;
    }

    // Validate message
    const validation = validateMessage(content);
    if (!validation.valid) {
      socket.emit("error", { message: validation.error });
      return;
    }

    // Create and save message
    const message = new Message({
      content: content.trim(),
      sender: userId,
      chatType: "world",
      messageType: "text",
    });

    await message.save();
    await message.populate("sender", "firstName lastName country");

    // Transform message for broadcast
    const transformedMessage = transformMessage(message, userId);

    // Broadcast to all users
    io.emit("world_message", {
      type: "world_message",
      message: transformedMessage,
    });

    // Update user activity
    updateUserActivity(userId);

    console.log(
      `🌍 World message from ${user.firstName}: ${content.substring(0, 50)}...`
    );
  } catch (error) {
    console.error("Error handling world message:", error);
    socket.emit("error", { message: "Failed to send message" });
  }
}

/**
 * Handle group chat messages with enhanced security
 */
async function handleGroupMessage(io, socket, data) {
  try {
    const { userId, user } = socket;
    const { content, chatId } = data.message || data;

    // Rate limiting
    if (!checkRateLimit(userId)) {
      socket.emit("error", {
        message: "Too many messages. Please slow down.",
        type: "RATE_LIMIT",
      });
      return;
    }

    // Validate message
    const validation = validateMessage(content);
    if (!validation.valid) {
      socket.emit("error", { message: validation.error });
      return;
    }

    // Verify user access to group
    const chatRoom = await ChatRoom.findById(chatId);
    if (!chatRoom || !chatRoom.isParticipant(userId)) {
      socket.emit("error", {
        message: "Access denied to this group",
        type: "ACCESS_DENIED",
      });
      return;
    }

    // Create message
    const message = new Message({
      content: content.trim(),
      sender: userId,
      chatType: "group",
      chatRoom: chatId,
      messageType: "text",
    });

    await message.save();
    await message.populate("sender", "firstName lastName country");

    // Update group's last message
    chatRoom.lastMessage = message._id;
    chatRoom.lastActivity = new Date();
    await chatRoom.save();

    // Transform and broadcast
    const transformedMessage = transformMessage(message, userId, chatId);

    io.to(`group_${chatId}`).emit("group_message", {
      type: "group_message",
      message: transformedMessage,
    });

    // Update room activity
    updateRoomActivity(`group_${chatId}`, userId);
    updateUserActivity(userId);

    console.log(`👥 Group message in ${chatRoom.name} from ${user.firstName}`);
  } catch (error) {
    console.error("Error handling group message:", error);
    socket.emit("error", { message: "Failed to send message" });
  }
}

/**
 * Handle private messages with auto-room creation
 */
async function handlePrivateMessage(io, socket, data) {
  try {
    const { userId, user } = socket;
    const { content, recipientId } = data.message || data;

    // Rate limiting
    if (!checkRateLimit(userId)) {
      socket.emit("error", {
        message: "Too many messages. Please slow down.",
        type: "RATE_LIMIT",
      });
      return;
    }

    // Validate message
    const validation = validateMessage(content);
    if (!validation.valid) {
      socket.emit("error", { message: validation.error });
      return;
    }

    // Self-message check
    if (userId === recipientId) {
      socket.emit("error", { message: "Cannot send message to yourself" });
      return;
    }

    // Find or create private chat
    let chatRoom = await findOrCreatePrivateChat(userId, recipientId, user);
    if (!chatRoom) {
      socket.emit("error", { message: "Unable to create chat with this user" });
      return;
    }

    // Create message
    const message = new Message({
      content: content.trim(),
      sender: userId,
      chatType: "private",
      chatRoom: chatRoom._id,
      messageType: "text",
    });

    await message.save();
    await message.populate("sender", "firstName lastName country");

    // Update chat
    chatRoom.lastMessage = message._id;
    chatRoom.lastActivity = new Date();
    await chatRoom.save();

    // Ensure both users are in the room
    await ensureUsersInPrivateRoom(io, chatRoom._id, userId, recipientId);

    // Transform and send
    const transformedMessage = transformMessage(message, userId, chatRoom._id);

    io.to(`private_${chatRoom._id}`).emit("private_message", {
      type: "private_message",
      message: transformedMessage,
    });

    updateUserActivity(userId);

    console.log(`💬 Private message from ${user.firstName} to ${recipientId}`);
  } catch (error) {
    console.error("Error handling private message:", error);
    socket.emit("error", { message: "Failed to send message" });
  }
}

/**
 * Enhanced typing indicators with cleanup
 */
function handleTypingStart(socket, data) {
  const { userId, user } = socket;
  const { chatType, chatId } = data;

  const typingData = {
    userId,
    username: `${user.firstName} ${user.lastName}`,
    chatType,
    chatId,
    timestamp: Date.now(),
  };

  // Broadcast typing indicator
  if (chatType === "world") {
    socket.broadcast.emit("user_typing", typingData);
  } else if (chatType === "group" && chatId) {
    socket.to(`group_${chatId}`).emit("user_typing", typingData);
  } else if (chatType === "private" && chatId) {
    socket.to(`private_${chatId}`).emit("user_typing", typingData);
  }

  // Auto-cleanup typing indicator after 10 seconds
  setTimeout(() => {
    handleTypingStop(socket, data);
  }, 10000);
}

function handleTypingStop(socket, data) {
  const { userId } = socket;
  const { chatType, chatId } = data;

  const stopData = { userId, chatType, chatId };

  if (chatType === "world") {
    socket.broadcast.emit("user_stopped_typing", stopData);
  } else if (chatType === "group" && chatId) {
    socket.to(`group_${chatId}`).emit("user_stopped_typing", stopData);
  } else if (chatType === "private" && chatId) {
    socket.to(`private_${chatId}`).emit("user_stopped_typing", stopData);
  }
}

/**
 * Handle user disconnection with cleanup
 */
async function handleDisconnect(io, socket) {
  try {
    const { userId, user } = socket;

    console.log(
      `👋 User disconnected: ${user.firstName} ${user.lastName} (${userId})`
    );

    // Clean up user data
    await cleanupUserSession(userId);

    // Broadcast updates
    await broadcastUserLeft(io, userId);
  } catch (error) {
    console.error("Error handling disconnect:", error);
  }
}

/**
 * Join user to their existing rooms
 */
async function joinUserRooms(socket, userId) {
  try {
    // Join group rooms
    const userGroups = await ChatRoom.find({
      participants: userId,
      type: "group",
    }).limit(CONFIG.MAX_ROOMS_PER_USER);

    for (const group of userGroups) {
      const roomId = `group_${group._id}`;
      socket.join(roomId);
      addUserToRoom(roomId, userId);
    }

    // Join private chat rooms
    const privateChats = await ChatRoom.find({
      participants: userId,
      type: "private",
    }).limit(CONFIG.MAX_ROOMS_PER_USER);

    for (const chat of privateChats) {
      const roomId = `private_${chat._id}`;
      socket.join(roomId);
      addUserToRoom(roomId, userId);
    }

    console.log(
      `📡 User ${userId} joined ${
        userGroups.length + privateChats.length
      } rooms`
    );
  } catch (error) {
    console.error("Error joining user rooms:", error);
  }
}

/**
 * Utility Functions
 */

function validateMessage(content) {
  if (!content || typeof content !== "string") {
    return { valid: false, error: "Message content is required" };
  }

  if (content.trim().length === 0) {
    return { valid: false, error: "Message cannot be empty" };
  }

  if (content.trim().length > CONFIG.MESSAGE_MAX_LENGTH) {
    return {
      valid: false,
      error: `Message too long (max ${CONFIG.MESSAGE_MAX_LENGTH} characters)`,
    };
  }

  return { valid: true };
}

function checkRateLimit(userId) {
  const now = Date.now();
  const userLimit = rateLimitStore.get(userId);

  if (!userLimit) return true;

  // Reset if window expired
  if (now - userLimit.lastReset > CONFIG.RATE_LIMIT.WINDOW) {
    userLimit.messages = [];
    userLimit.lastReset = now;
  }

  // Clean old messages
  userLimit.messages = userLimit.messages.filter(
    (timestamp) => now - timestamp < CONFIG.RATE_LIMIT.WINDOW
  );

  // Check limit
  if (userLimit.messages.length >= CONFIG.RATE_LIMIT.MAX_MESSAGES) {
    return false;
  }

  // Add current message
  userLimit.messages.push(now);
  return true;
}

function transformMessage(message, currentUserId, chatId = null) {
  return {
    id: message._id,
    content: message.content,
    senderId: message.sender._id,
    senderName: `${message.sender.firstName} ${message.sender.lastName}`,
    senderCountry: message.sender.country,
    timestamp: message.createdAt,
    chatType: message.chatType,
    chatId: chatId,
    isOwnMessage: message.sender._id.toString() === currentUserId.toString(),
    deliveredTo: message.deliveredTo || [],
    readBy: message.readBy || [],
  };
}

async function findOrCreatePrivateChat(userId, recipientId, user) {
  // Check if recipient exists
  const recipient = await User.findById(recipientId);
  if (!recipient) return null;

  // Find existing chat
  let chatRoom = await ChatRoom.findOne({
    type: "private",
    participants: { $all: [userId, recipientId] },
  });

  // Create new chat if doesn't exist
  if (!chatRoom) {
    chatRoom = new ChatRoom({
      name: `${user.firstName} & ${recipient.firstName}`,
      type: "private",
      participants: [userId, recipientId],
      createdBy: userId,
    });
    await chatRoom.save();
  }

  return chatRoom;
}

async function ensureUsersInPrivateRoom(io, chatId, userId1, userId2) {
  const roomId = `private_${chatId}`;

  // Add both users to room tracking
  addUserToRoom(roomId, userId1);
  addUserToRoom(roomId, userId2);

  // Ensure both sockets are in the room
  const user1Socket = findUserSocket(io, userId1);
  const user2Socket = findUserSocket(io, userId2);

  if (user1Socket) user1Socket.join(roomId);
  if (user2Socket) user2Socket.join(roomId);
}

function addUserToRoom(roomId, userId) {
  if (!roomUsers.has(roomId)) {
    roomUsers.set(roomId, new Set());
  }
  roomUsers.get(roomId).add(userId);
}

function removeUserFromRoom(roomId, userId) {
  const room = roomUsers.get(roomId);
  if (room) {
    room.delete(userId);
    if (room.size === 0) {
      roomUsers.delete(roomId);
    }
  }
}

function updateUserActivity(userId) {
  const user = connectedUsers.get(userId);
  if (user) {
    user.lastActivity = new Date();
    user.messageCount++;
  }
}

function updateRoomActivity(roomId, userId) {
  // Could be used for room-specific analytics
  console.log(`📊 Room ${roomId} activity from user ${userId}`);
}

async function cleanupUserSession(userId) {
  try {
    // Update database
    const user = await User.findById(userId);
    if (user) {
      await user.updateLastSeen();
    }

    // Clean up memory
    connectedUsers.delete(userId);
    rateLimitStore.delete(userId);

    // Remove from all rooms
    for (const [roomId, users] of roomUsers.entries()) {
      removeUserFromRoom(roomId, userId);
    }
  } catch (error) {
    console.error("Error cleaning up user session:", error);
  }
}

function findUserSocket(io, userId) {
  const userConnection = connectedUsers.get(userId);
  if (userConnection) {
    return io.sockets.sockets.get(userConnection.socketId);
  }
  return null;
}

function sendToUser(io, userId, event, data) {
  const socket = findUserSocket(io, userId);
  if (socket) {
    socket.emit(event, data);
    return true;
  }
  return false;
}

function kickUser(io, userId, reason = "Violation of terms") {
  const socket = findUserSocket(io, userId);
  if (socket) {
    socket.emit("kicked", { reason });
    socket.disconnect();
    return true;
  }
  return false;
}

async function broadcastOnlineUsers(io) {
  try {
    const onlineUsers = await User.findOnlineUsers();
    const transformedUsers = onlineUsers.map((user) => ({
      id: user._id,
      username: `${user.firstName} ${user.lastName}`,
      country: user.country,
      isOnline: user.isOnline,
      lastSeen: user.lastSeen,
      avatar: user.avatar,
    }));

    io.emit("online_users", {
      type: "online_users",
      users: transformedUsers,
      count: transformedUsers.length,
    });
  } catch (error) {
    console.error("Error broadcasting online users:", error);
  }
}

async function broadcastUserJoined(io, socket, user) {
  await broadcastOnlineUsers(io);

  socket.broadcast.emit("user_joined", {
    userId: socket.userId,
    username: `${user.firstName} ${user.lastName}`,
    country: user.country,
    isOnline: true,
    joinedAt: new Date(),
  });
}

async function broadcastUserLeft(io, userId) {
  await broadcastOnlineUsers(io);

  io.emit("user_left", {
    userId: userId,
    leftAt: new Date(),
  });
}

/**
 * Setup periodic maintenance tasks
 */
function setupPeriodicTasks(io) {
  // Cleanup disconnected users
  setInterval(async () => {
    try {
      const now = new Date();
      const threshold = new Date(now.getTime() - CONFIG.OFFLINE_THRESHOLD);

      // Update database
      await User.updateMany(
        {
          isOnline: true,
          lastSeen: { $lt: threshold },
        },
        {
          isOnline: false,
          socketId: null,
        }
      );

      // Clean up memory
      for (const [userId, connection] of connectedUsers.entries()) {
        const socket = io.sockets.sockets.get(connection.socketId);
        if (!socket || connection.lastActivity < threshold) {
          await cleanupUserSession(userId);
        }
      }

      // Broadcast if changes occurred
      const currentOnlineCount = await User.countDocuments({ isOnline: true });
      if (currentOnlineCount !== connectedUsers.size) {
        await broadcastOnlineUsers(io);
      }
    } catch (error) {
      console.error("Error in cleanup task:", error);
    }
  }, CONFIG.CLEANUP_INTERVAL);

  // Stats logging
  setInterval(() => {
    const stats = {
      connectedUsers: connectedUsers.size,
      totalSockets: io.sockets.sockets.size,
      activeRooms: roomUsers.size,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage(),
    };

    console.log(`📊 Socket Stats:`, {
      users: stats.connectedUsers,
      sockets: stats.totalSockets,
      rooms: stats.activeRooms,
      uptime: `${Math.floor(stats.uptime / 3600)}h ${Math.floor(
        (stats.uptime % 3600) / 60
      )}m`,
    });
  }, CONFIG.STATS_INTERVAL);
}

module.exports = socketHandler;
