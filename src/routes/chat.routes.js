// routes/chat.js - Fixed chat routes with proper syntax
const express = require("express");
const router = express.Router();
const { body, query, param, validationResult } = require("express-validator");

// Import models
const User = require("../models/User");
const ChatRoom = require("../models/ChatRoom.js");
const { Message } = require("../models/Message");

/**
 * Simple rate limiting (replace with your auth middleware rate limiting if available)
 */
const messageRateLimit = (req, res, next) => {
  // Simple implementation - you can replace with your enhanced createRateLimit
  next();
};

/**
 * Validation middleware
 */
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: errors.array(),
    });
  }
  next();
};

/**
 * Helper function to get socket utilities
 */
const getSocketUtils = (req) => {
  return req.app.get("socketUtils");
};

/**
 * Helper function to get IO instance
 */
const getIO = (req) => {
  return req.app.get("io");
};

/**
 * Helper function to transform messages for frontend
 */
const transformMessage = (message, currentUserId) => ({
  id: message._id,
  content: message.content,
  senderId: message.sender._id,
  senderName: `${message.sender.firstName} ${message.sender.lastName}`,
  senderCountry: message.sender.country,
  senderAvatar: message.sender.avatar,
  timestamp: message.createdAt,
  updatedAt: message.updatedAt,
  chatType: message.chatType,
  chatId: message.chatRoom,
  messageType: message.messageType || "text",
  isOwnMessage: message.sender._id.toString() === currentUserId.toString(),
  deliveredTo: message.deliveredTo || [],
  readBy: message.readBy || [],
  editedAt: message.editedAt,
  isEdited: !!message.editedAt,
});

/**
 * Helper function to transform chat rooms
 */
const transformChatRoom = (chatRoom, currentUserId) => {
  if (chatRoom.type === "private") {
    // For private chats, show the other participant's name
    const otherParticipant = chatRoom.participants.find(
      (p) => p._id.toString() !== currentUserId.toString()
    );

    return {
      id: chatRoom._id,
      name: otherParticipant
        ? `${otherParticipant.firstName} ${otherParticipant.lastName}`
        : "Unknown User",
      type: "private",
      participants: chatRoom.participants.map((p) => ({
        id: p._id,
        name: `${p.firstName} ${p.lastName}`,
        avatar: p.avatar,
        isOnline: p.isOnline,
        country: p.country,
      })),
      createdAt: chatRoom.createdAt,
      updatedAt: chatRoom.updatedAt,
      lastMessage: chatRoom.lastMessage
        ? {
            content: chatRoom.lastMessage.content,
            timestamp: chatRoom.lastMessage.createdAt,
            senderId: chatRoom.lastMessage.sender,
          }
        : null,
      avatar: otherParticipant?.avatar,
      unreadCount: chatRoom.unreadCount || 0,
    };
  } else {
    // For group chats
    return {
      id: chatRoom._id,
      name: chatRoom.name,
      description: chatRoom.description,
      type: "group",
      participants: chatRoom.participants.map((p) => ({
        id: p._id,
        name: `${p.firstName} ${p.lastName}`,
        avatar: p.avatar,
        isOnline: p.isOnline,
        country: p.country,
      })),
      admins: chatRoom.admins || [],
      createdBy: chatRoom.createdBy,
      createdAt: chatRoom.createdAt,
      updatedAt: chatRoom.updatedAt,
      lastMessage: chatRoom.lastMessage
        ? {
            content: chatRoom.lastMessage.content,
            timestamp: chatRoom.lastMessage.createdAt,
            senderId: chatRoom.lastMessage.sender,
          }
        : null,
      avatar: chatRoom.avatar,
      memberCount: chatRoom.participants.length,
      unreadCount: chatRoom.unreadCount || 0,
    };
  }
};

/**
 * WORLD CHAT ROUTES
 */

// Get world chat messages
router.get(
  "/world/messages",
  [
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("skip")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Skip must be a non-negative integer"),
    query("before")
      .optional()
      .isISO8601()
      .withMessage("Before must be a valid date"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { limit = 50, skip = 0, before } = req.query;

      // Build query conditions
      const queryConditions = { chatType: "world" };
      if (before) {
        queryConditions.createdAt = { $lt: new Date(before) };
      }

      // Use your existing Message.getWorldMessages or build query
      const messages = await Message.find(queryConditions)
        .populate("sender", "firstName lastName country avatar")
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip(parseInt(skip));

      const transformedMessages = messages
        .reverse()
        .map((msg) => transformMessage(msg, req.user.id));

      res.json({
        success: true,
        messages: transformedMessages,
        pagination: {
          limit: parseInt(limit),
          skip: parseInt(skip),
          hasMore: messages.length === parseInt(limit),
        },
      });
    } catch (error) {
      console.error("Error fetching world messages:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch messages",
      });
    }
  }
);

// Send world chat message
router.post(
  "/world/messages",
  messageRateLimit,
  [
    body("content")
      .trim()
      .isLength({ min: 1, max: 2000 })
      .withMessage("Message content must be 1-2000 characters"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { content } = req.body;

      const message = new Message({
        content: content.trim(),
        sender: req.user.id,
        chatType: "world",
        messageType: "text",
      });

      await message.save();
      await message.populate("sender", "firstName lastName country avatar");

      const transformedMessage = transformMessage(message, req.user.id);

      // Broadcast via socket if available
      const io = getIO(req);
      if (io) {
        io.emit("world_message", {
          type: "world_message",
          message: transformedMessage,
        });
      }

      res.status(201).json({
        success: true,
        message: transformedMessage,
      });
    } catch (error) {
      console.error("Error sending world message:", error);
      res.status(500).json({
        success: false,
        message: "Failed to send message",
      });
    }
  }
);

/**
 * GROUP CHAT ROUTES
 */

// Get user's groups
router.get("/groups", async (req, res) => {
  try {
    const groups = await ChatRoom.find({
      participants: req.user.id,
      type: "group",
    })
      .populate("participants", "firstName lastName country isOnline avatar")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    const transformedGroups = groups.map((group) =>
      transformChatRoom(group, req.user.id)
    );

    res.json({
      success: true,
      groups: transformedGroups,
      count: transformedGroups.length,
    });
  } catch (error) {
    console.error("Error fetching groups:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch groups",
    });
  }
});

// Create new group
router.post(
  "/groups",
  [
    body("name")
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage("Group name must be 1-100 characters"),
    body("description")
      .optional()
      .trim()
      .isLength({ max: 500 })
      .withMessage("Description cannot exceed 500 characters"),
    body("participants")
      .optional()
      .isArray()
      .withMessage("Participants must be an array"),
    body("participants.*")
      .optional()
      .isMongoId()
      .withMessage("Each participant must be a valid user ID"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { name, participants = [], description } = req.body;

      // Validate participants exist
      if (participants.length > 0) {
        const validParticipants = await User.find({
          _id: { $in: participants },
        }).select("_id");

        if (validParticipants.length !== participants.length) {
          return res.status(400).json({
            success: false,
            message: "Some participants were not found",
          });
        }
      }

      // Add creator to participants
      const allParticipants = [...new Set([req.user.id, ...participants])];

      const chatRoom = new ChatRoom({
        name: name.trim(),
        type: "group",
        participants: allParticipants,
        createdBy: req.user.id,
        admins: [req.user.id],
        description: description?.trim(),
      });

      await chatRoom.save();
      await chatRoom.populate(
        "participants",
        "firstName lastName email country isOnline avatar"
      );

      // Update user's joined groups if this field exists
      try {
        await User.findByIdAndUpdate(req.user.id, {
          $addToSet: { joinedGroups: chatRoom._id },
        });
      } catch (updateError) {
        // Field might not exist, that's okay
        console.log("joinedGroups field not found, skipping update");
      }

      // Notify participants via socket
      const socketUtils = getSocketUtils(req);
      if (socketUtils) {
        allParticipants.forEach((participantId) => {
          if (participantId !== req.user.id) {
            socketUtils.sendToUser(participantId, "group_created", {
              group: transformChatRoom(chatRoom, participantId),
              invitedBy: {
                id: req.user.id,
                firstName: req.user.firstName,
                lastName: req.user.lastName,
                country: req.user.country,
              },
            });
          }
        });
      }

      res.status(201).json({
        success: true,
        group: transformChatRoom(chatRoom, req.user.id),
      });
    } catch (error) {
      console.error("Error creating group:", error);
      res.status(500).json({
        success: false,
        message: "Failed to create group",
      });
    }
  }
);

// Get group messages
router.get(
  "/groups/:groupId/messages",
  [
    param("groupId").isMongoId().withMessage("Valid group ID required"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("skip")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Skip must be a non-negative integer"),
    query("before")
      .optional()
      .isISO8601()
      .withMessage("Before must be a valid date"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { limit = 50, skip = 0, before } = req.query;

      // Check if user is participant
      const chatRoom = await ChatRoom.findById(groupId);
      if (!chatRoom) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      // Check if user is participant
      if (!chatRoom.participants.includes(req.user.id)) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      // Build query
      const queryConditions = { chatRoom: groupId, chatType: "group" };
      if (before) {
        queryConditions.createdAt = { $lt: new Date(before) };
      }

      const messages = await Message.find(queryConditions)
        .populate("sender", "firstName lastName country avatar")
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip(parseInt(skip));

      const transformedMessages = messages
        .reverse()
        .map((msg) => transformMessage(msg, req.user.id));

      res.json({
        success: true,
        messages: transformedMessages,
        pagination: {
          limit: parseInt(limit),
          skip: parseInt(skip),
          hasMore: messages.length === parseInt(limit),
        },
      });
    } catch (error) {
      console.error("Error fetching group messages:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch group messages",
      });
    }
  }
);

// Send group message
router.post(
  "/groups/:groupId/messages",
  messageRateLimit,
  [
    param("groupId").isMongoId().withMessage("Valid group ID required"),
    body("content")
      .trim()
      .isLength({ min: 1, max: 2000 })
      .withMessage("Message content must be 1-2000 characters"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { groupId } = req.params;
      const { content } = req.body;

      // Check if user is participant
      const chatRoom = await ChatRoom.findById(groupId);
      if (!chatRoom) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      if (!chatRoom.participants.includes(req.user.id)) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      const message = new Message({
        content: content.trim(),
        sender: req.user.id,
        chatType: "group",
        chatRoom: groupId,
        messageType: "text",
      });

      await message.save();
      await message.populate("sender", "firstName lastName country avatar");

      // Update group's last message
      chatRoom.lastMessage = message._id;
      chatRoom.lastActivity = new Date();
      await chatRoom.save();

      const transformedMessage = transformMessage(message, req.user.id);

      // Broadcast via socket
      const io = getIO(req);
      if (io) {
        io.to(`group_${groupId}`).emit("group_message", {
          type: "group_message",
          message: transformedMessage,
        });
      }

      res.status(201).json({
        success: true,
        message: transformedMessage,
      });
    } catch (error) {
      console.error("Error sending group message:", error);
      res.status(500).json({
        success: false,
        message: "Failed to send message",
      });
    }
  }
);

/**
 * PRIVATE CHAT ROUTES
 */

// Get user's private chats
router.get("/private", async (req, res) => {
  try {
    const privateChats = await ChatRoom.find({
      participants: req.user.id,
      type: "private",
    })
      .populate("participants", "firstName lastName country isOnline avatar")
      .populate("lastMessage")
      .sort({ updatedAt: -1 });

    const transformedChats = privateChats.map((chat) =>
      transformChatRoom(chat, req.user.id)
    );

    res.json({
      success: true,
      chats: transformedChats,
      count: transformedChats.length,
    });
  } catch (error) {
    console.error("Error fetching private chats:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch private chats",
    });
  }
});

// Start private chat
router.post(
  "/private/start",
  [
    body("participantId")
      .isMongoId()
      .withMessage("Valid participant ID required"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { participantId } = req.body;

      if (participantId === req.user.id.toString()) {
        return res.status(400).json({
          success: false,
          message: "Cannot start chat with yourself",
        });
      }

      // Check if participant exists
      const participant = await User.findById(participantId).select(
        "firstName lastName avatar isOnline"
      );
      if (!participant) {
        return res.status(404).json({
          success: false,
          message: "User not found",
        });
      }

      // Check if chat already exists
      let chatRoom = await ChatRoom.findOne({
        type: "private",
        participants: { $all: [req.user.id, participantId] },
      }).populate("participants", "firstName lastName avatar isOnline");

      if (chatRoom) {
        return res.json({
          success: true,
          chat: transformChatRoom(chatRoom, req.user.id),
          isNew: false,
        });
      }

      // Create new private chat
      chatRoom = new ChatRoom({
        name: `${req.user.firstName} & ${participant.firstName}`,
        type: "private",
        participants: [req.user.id, participantId],
        createdBy: req.user.id,
      });

      await chatRoom.save();
      await chatRoom.populate(
        "participants",
        "firstName lastName avatar isOnline"
      );

      // Notify the other participant
      const socketUtils = getSocketUtils(req);
      if (socketUtils) {
        socketUtils.sendToUser(participantId, "private_chat_created", {
          chat: transformChatRoom(chatRoom, participantId),
          createdBy: {
            id: req.user.id,
            firstName: req.user.firstName,
            lastName: req.user.lastName,
            country: req.user.country,
          },
        });
      }

      res.status(201).json({
        success: true,
        chat: transformChatRoom(chatRoom, req.user.id),
        isNew: true,
      });
    } catch (error) {
      console.error("Error starting private chat:", error);
      res.status(500).json({
        success: false,
        message: "Failed to start private chat",
      });
    }
  }
);

// Get private messages
router.get(
  "/private/:chatId/messages",
  [
    param("chatId").isMongoId().withMessage("Valid chat ID required"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage("Limit must be between 1 and 100"),
    query("skip")
      .optional()
      .isInt({ min: 0 })
      .withMessage("Skip must be a non-negative integer"),
    query("before")
      .optional()
      .isISO8601()
      .withMessage("Before must be a valid date"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { chatId } = req.params;
      const { limit = 50, skip = 0, before } = req.query;

      // Check if user is participant
      const chatRoom = await ChatRoom.findById(chatId);
      if (!chatRoom) {
        return res.status(404).json({
          success: false,
          message: "Chat not found",
        });
      }

      if (!chatRoom.participants.includes(req.user.id)) {
        return res.status(403).json({
          success: false,
          message: "Access denied",
        });
      }

      // Build query
      const queryConditions = { chatRoom: chatId, chatType: "private" };
      if (before) {
        queryConditions.createdAt = { $lt: new Date(before) };
      }

      const messages = await Message.find(queryConditions)
        .populate("sender", "firstName lastName country avatar")
        .sort({ createdAt: -1 })
        .limit(parseInt(limit))
        .skip(parseInt(skip));

      const transformedMessages = messages
        .reverse()
        .map((msg) => transformMessage(msg, req.user.id));

      res.json({
        success: true,
        messages: transformedMessages,
        pagination: {
          limit: parseInt(limit),
          skip: parseInt(skip),
          hasMore: messages.length === parseInt(limit),
        },
      });
    } catch (error) {
      console.error("Error fetching private messages:", error);
      res.status(500).json({
        success: false,
        message: "Failed to fetch private messages",
      });
    }
  }
);

// Send private message
router.post(
  "/private/messages",
  messageRateLimit,
  [
    body("recipientId").isMongoId().withMessage("Valid recipient ID required"),
    body("content")
      .trim()
      .isLength({ min: 1, max: 2000 })
      .withMessage("Message content must be 1-2000 characters"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { recipientId, content } = req.body;

      if (recipientId === req.user.id.toString()) {
        return res.status(400).json({
          success: false,
          message: "Cannot send message to yourself",
        });
      }

      // Find or create private chat
      let chatRoom = await ChatRoom.findOne({
        type: "private",
        participants: { $all: [req.user.id, recipientId] },
      });

      if (!chatRoom) {
        const recipient = await User.findById(recipientId);
        if (!recipient) {
          return res.status(404).json({
            success: false,
            message: "Recipient not found",
          });
        }

        chatRoom = new ChatRoom({
          name: `${req.user.firstName} & ${recipient.firstName}`,
          type: "private",
          participants: [req.user.id, recipientId],
          createdBy: req.user.id,
        });

        await chatRoom.save();
      }

      const message = new Message({
        content: content.trim(),
        sender: req.user.id,
        chatType: "private",
        chatRoom: chatRoom._id,
        messageType: "text",
      });

      await message.save();
      await message.populate("sender", "firstName lastName country avatar");

      // Update chat's last message
      chatRoom.lastMessage = message._id;
      chatRoom.lastActivity = new Date();
      await chatRoom.save();

      const transformedMessage = transformMessage(message, req.user.id);

      // Send via socket
      const io = getIO(req);
      if (io) {
        io.to(`private_${chatRoom._id}`).emit("private_message", {
          type: "private_message",
          message: transformedMessage,
        });
      }

      res.status(201).json({
        success: true,
        message: transformedMessage,
        chatId: chatRoom._id,
      });
    } catch (error) {
      console.error("Error sending private message:", error);
      res.status(500).json({
        success: false,
        message: "Failed to send message",
      });
    }
  }
);

/**
 * USER AND STATUS ROUTES
 */

// Get online users
router.get("/online-users", async (req, res) => {
  try {
    const onlineUsers = await User.find({ isOnline: true })
      .select("firstName lastName country isOnline lastSeen avatar")
      .sort({ lastSeen: -1 });

    const socketUtils = getSocketUtils(req);

    const transformedUsers = onlineUsers.map((user) => ({
      id: user._id,
      username: `${user.firstName} ${user.lastName}`,
      firstName: user.firstName,
      lastName: user.lastName,
      country: user.country,
      isOnline: user.isOnline,
      lastSeen: user.lastSeen,
      avatar: user.avatar,
    }));

    res.json({
      success: true,
      users: transformedUsers,
      count: transformedUsers.length,
      socketCount: socketUtils ? socketUtils.getOnlineUsersCount() : 0,
    });
  } catch (error) {
    console.error("Error fetching online users:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch online users",
    });
  }
});

// Search users for chat
router.get(
  "/search/users",
  [
    query("q")
      .trim()
      .isLength({ min: 1, max: 50 })
      .withMessage("Search query must be 1-50 characters"),
    query("limit")
      .optional()
      .isInt({ min: 1, max: 20 })
      .withMessage("Limit must be between 1 and 20"),
  ],
  validateRequest,
  async (req, res) => {
    try {
      const { q, limit = 10 } = req.query;

      const searchRegex = new RegExp(q, "i");
      const users = await User.find({
        _id: { $ne: req.user.id },
        $or: [
          { firstName: searchRegex },
          { lastName: searchRegex },
          { email: searchRegex },
        ],
      })
        .select("firstName lastName email country isOnline avatar")
        .limit(parseInt(limit));

      const transformedUsers = users.map((user) => ({
        id: user._id,
        username: `${user.firstName} ${user.lastName}`,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        country: user.country,
        isOnline: user.isOnline,
        avatar: user.avatar,
      }));

      res.json({
        success: true,
        users: transformedUsers,
        count: transformedUsers.length,
        query: q,
      });
    } catch (error) {
      console.error("Error searching users:", error);
      res.status(500).json({
        success: false,
        message: "Failed to search users",
      });
    }
  }
);

// Get user's chat statistics
router.get("/stats", async (req, res) => {
  try {
    const [totalMessages, groupCount, privateChatsCount, todayMessages] =
      await Promise.all([
        Message.countDocuments({ sender: req.user.id }),
        ChatRoom.countDocuments({
          participants: req.user.id,
          type: "group",
        }),
        ChatRoom.countDocuments({
          participants: req.user.id,
          type: "private",
        }),
        Message.countDocuments({
          sender: req.user.id,
          createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
        }),
      ]);

    res.json({
      success: true,
      stats: {
        totalMessages,
        groupCount,
        privateChatsCount,
        todayMessages,
        joinedAt: req.user.createdAt,
      },
    });
  } catch (error) {
    console.error("Error fetching chat stats:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch statistics",
    });
  }
});

module.exports = router;
