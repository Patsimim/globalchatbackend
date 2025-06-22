const mongoose = require("mongoose");

const messageSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: [true, "Message content is required"],
      trim: true,
      maxlength: [2000, "Message cannot exceed 2000 characters"],
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "Sender is required"],
    },
    chatRoom: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ChatRoom",
      default: null, // null for world chat
    },
    chatType: {
      type: String,
      enum: ["world", "group", "private"],
      required: true,
      default: "world",
    },
    messageType: {
      type: String,
      enum: ["text", "image", "file", "audio", "video", "system"],
      default: "text",
    },
    // For file/media messages
    attachments: [
      {
        type: {
          type: String,
          enum: ["image", "file", "audio", "video"],
        },
        url: {
          type: String,
          required: true,
        },
        filename: String,
        size: Number, // in bytes
        mimeType: String,
      },
    ],
    // Message status
    isEdited: {
      type: Boolean,
      default: false,
    },
    editedAt: {
      type: Date,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
    },
    deletedAt: {
      type: Date,
      default: null,
    },
    deletedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    // Read receipts
    deliveredTo: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        deliveredAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    readBy: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        readAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // Reply functionality
    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    // Reactions
    reactions: [
      {
        emoji: {
          type: String,
          required: true,
        },
        users: [
          {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
          },
        ],
        count: {
          type: Number,
          default: 0,
        },
      },
    ],
    // Moderation
    isReported: {
      type: Boolean,
      default: false,
    },
    reports: [
      {
        reportedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        reason: String,
        reportedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
    // System message data
    systemData: {
      type: mongoose.Schema.Types.Mixed,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for better performance
messageSchema.index({ sender: 1 });
messageSchema.index({ chatRoom: 1 });
messageSchema.index({ chatType: 1 });
messageSchema.index({ createdAt: -1 });
messageSchema.index({ chatRoom: 1, createdAt: -1 });
messageSchema.index({ chatType: 1, createdAt: -1 });
messageSchema.index({ sender: 1, createdAt: -1 });
messageSchema.index({ isDeleted: 1 });

// Virtual for reaction count
messageSchema.virtual("totalReactions").get(function () {
  return this.reactions.reduce((total, reaction) => total + reaction.count, 0);
});

// Virtual to check if message is a reply
messageSchema.virtual("isReply").get(function () {
  return !!this.replyTo;
});

// Virtual to get file attachments only
messageSchema.virtual("fileAttachments").get(function () {
  return this.attachments.filter((att) => att.type === "file");
});

// Virtual to get image attachments only
messageSchema.virtual("imageAttachments").get(function () {
  return this.attachments.filter((att) => att.type === "image");
});

// Static method to get world chat messages
messageSchema.statics.getWorldMessages = function (
  limit = 50,
  skip = 0,
  before = null
) {
  const query = {
    chatType: "world",
    isDeleted: false,
  };

  if (before) {
    query.createdAt = { $lt: new Date(before) };
  }

  return this.find(query)
    .populate("sender", "username displayName profilePicture")
    .populate("replyTo", "content sender")
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip);
};

// Static method to get chat room messages
messageSchema.statics.getChatRoomMessages = function (
  chatRoomId,
  limit = 50,
  skip = 0,
  before = null
) {
  const query = {
    chatRoom: chatRoomId,
    isDeleted: false,
  };

  if (before) {
    query.createdAt = { $lt: new Date(before) };
  }

  return this.find(query)
    .populate("sender", "username displayName profilePicture")
    .populate("replyTo", "content sender")
    .sort({ createdAt: -1 })
    .limit(limit)
    .skip(skip);
};

// Static method to get unread messages count
messageSchema.statics.getUnreadCount = function (userId, chatRoomId = null) {
  const query = { isDeleted: false };

  if (chatRoomId) {
    query.chatRoom = chatRoomId;
  }

  // Messages not read by this user
  query["readBy.user"] = { $ne: userId };
  query.sender = { $ne: userId }; // Don't count own messages

  return this.countDocuments(query);
};

// Instance method to mark as read by user
messageSchema.methods.markAsReadBy = function (userId) {
  // Check if already read
  const alreadyRead = this.readBy.some(
    (read) => read.user.toString() === userId.toString()
  );

  if (!alreadyRead) {
    this.readBy.push({
      user: userId,
      readAt: new Date(),
    });
    return this.save();
  }

  return Promise.resolve(this);
};

// Instance method to mark as delivered to user
messageSchema.methods.markAsDeliveredTo = function (userId) {
  // Check if already delivered
  const alreadyDelivered = this.deliveredTo.some(
    (delivery) => delivery.user.toString() === userId.toString()
  );

  if (!alreadyDelivered) {
    this.deliveredTo.push({
      user: userId,
      deliveredAt: new Date(),
    });
    return this.save();
  }

  return Promise.resolve(this);
};

// Instance method to add reaction
messageSchema.methods.addReaction = function (emoji, userId) {
  const existingReaction = this.reactions.find((r) => r.emoji === emoji);

  if (existingReaction) {
    // Check if user already reacted with this emoji
    if (!existingReaction.users.includes(userId)) {
      existingReaction.users.push(userId);
      existingReaction.count = existingReaction.users.length;
    }
  } else {
    // Add new reaction
    this.reactions.push({
      emoji,
      users: [userId],
      count: 1,
    });
  }

  return this.save();
};

// Instance method to remove reaction
messageSchema.methods.removeReaction = function (emoji, userId) {
  const reactionIndex = this.reactions.findIndex((r) => r.emoji === emoji);

  if (reactionIndex !== -1) {
    const reaction = this.reactions[reactionIndex];
    reaction.users = reaction.users.filter(
      (user) => user.toString() !== userId.toString()
    );
    reaction.count = reaction.users.length;

    // Remove reaction if no users left
    if (reaction.count === 0) {
      this.reactions.splice(reactionIndex, 1);
    }
  }

  return this.save();
};

// Instance method to edit message
messageSchema.methods.editContent = function (newContent) {
  this.content = newContent;
  this.isEdited = true;
  this.editedAt = new Date();
  return this.save();
};

// Instance method to soft delete
messageSchema.methods.softDelete = function (deletedByUserId = null) {
  this.isDeleted = true;
  this.deletedAt = new Date();
  if (deletedByUserId) {
    this.deletedBy = deletedByUserId;
  }
  return this.save();
};

// Instance method to report message
messageSchema.methods.reportMessage = function (reportedByUserId, reason) {
  this.reports.push({
    reportedBy: reportedByUserId,
    reason,
    reportedAt: new Date(),
  });
  this.isReported = true;
  return this.save();
};

// Pre-save middleware
messageSchema.pre("save", function (next) {
  // Update reaction counts
  this.reactions.forEach((reaction) => {
    reaction.count = reaction.users.length;
  });

  // Remove empty reactions
  this.reactions = this.reactions.filter((reaction) => reaction.count > 0);

  next();
});

// Post-save middleware to update chat room's last message
messageSchema.post("save", async function (doc) {
  if (doc.chatRoom && !doc.isDeleted) {
    try {
      const ChatRoom = mongoose.model("ChatRoom");
      await ChatRoom.findByIdAndUpdate(doc.chatRoom, {
        lastMessage: doc._id,
        lastActivity: new Date(),
        $inc: { messageCount: 1 },
      });
    } catch (error) {
      console.error("Error updating chat room last message:", error);
    }
  }
});

const Message = mongoose.model("Message", messageSchema);

module.exports = { Message, messageSchema };
