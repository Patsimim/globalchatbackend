const mongoose = require("mongoose");

const chatRoomSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, "Chat room name is required"],
      trim: true,
      maxlength: [100, "Chat room name cannot exceed 100 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, "Description cannot exceed 500 characters"],
      default: null,
    },
    type: {
      type: String,
      enum: ["private", "group", "world"],
      required: true,
      default: "group",
    },
    participants: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
      },
    ],
    admins: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },
    lastActivity: {
      type: Date,
      default: Date.now,
    },
    avatar: {
      type: String,
      default: null,
      validate: {
        validator: function (v) {
          return !v || /^https?:\/\/.+/.test(v);
        },
        message: "Avatar must be a valid URL",
      },
    },
    settings: {
      isPublic: {
        type: Boolean,
        default: false,
      },
      allowInvites: {
        type: Boolean,
        default: true,
      },
      maxMembers: {
        type: Number,
        default: 100,
        min: 2,
        max: 1000,
      },
    },
    // For private chats
    isActive: {
      type: Boolean,
      default: true,
    },
    // Moderation
    isMuted: {
      type: Boolean,
      default: false,
    },
    mutedUntil: {
      type: Date,
      default: null,
    },
    // Analytics
    messageCount: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Indexes for better performance
chatRoomSchema.index({ participants: 1 });
chatRoomSchema.index({ type: 1 });
chatRoomSchema.index({ createdBy: 1 });
chatRoomSchema.index({ lastActivity: -1 });
chatRoomSchema.index({ participants: 1, type: 1 });

// Virtual for member count
chatRoomSchema.virtual("memberCount").get(function () {
  return this.participants ? this.participants.length : 0;
});

// Virtual to check if user is admin
chatRoomSchema.virtual("isUserAdmin").get(function () {
  return function (userId) {
    return (
      this.admins &&
      this.admins.some((admin) => admin.toString() === userId.toString())
    );
  }.bind(this);
});

// Static method to find user's chat rooms
chatRoomSchema.statics.findUserChats = function (userId, type = null) {
  const query = { participants: userId };
  if (type) {
    query.type = type;
  }
  return this.find(query)
    .populate("participants", "username displayName profilePicture isOnline")
    .populate("lastMessage")
    .sort({ lastActivity: -1 });
};

// Static method to find or create private chat
chatRoomSchema.statics.findOrCreatePrivateChat = async function (
  user1Id,
  user2Id
) {
  // Look for existing private chat
  let chatRoom = await this.findOne({
    type: "private",
    participants: { $all: [user1Id, user2Id] },
  }).populate("participants", "username displayName profilePicture isOnline");

  if (!chatRoom) {
    // Create new private chat
    chatRoom = new this({
      name: "Private Chat",
      type: "private",
      participants: [user1Id, user2Id],
      createdBy: user1Id,
    });
    await chatRoom.save();
    await chatRoom.populate(
      "participants",
      "username displayName profilePicture isOnline"
    );
  }

  return chatRoom;
};

// Instance method to add participant
chatRoomSchema.methods.addParticipant = function (userId) {
  if (!this.participants.includes(userId)) {
    this.participants.push(userId);
    return this.save();
  }
  return Promise.resolve(this);
};

// Instance method to remove participant
chatRoomSchema.methods.removeParticipant = function (userId) {
  this.participants = this.participants.filter(
    (participant) => participant.toString() !== userId.toString()
  );
  return this.save();
};

// Instance method to add admin
chatRoomSchema.methods.addAdmin = function (userId) {
  if (!this.admins.includes(userId)) {
    this.admins.push(userId);
    return this.save();
  }
  return Promise.resolve(this);
};

// Instance method to remove admin
chatRoomSchema.methods.removeAdmin = function (userId) {
  this.admins = this.admins.filter(
    (admin) => admin.toString() !== userId.toString()
  );
  return this.save();
};

// Instance method to check if user is participant
chatRoomSchema.methods.hasParticipant = function (userId) {
  return this.participants.some(
    (participant) => participant.toString() === userId.toString()
  );
};

// Instance method to update last activity
chatRoomSchema.methods.updateLastActivity = function () {
  this.lastActivity = new Date();
  return this.save();
};

// Pre-save middleware
chatRoomSchema.pre("save", function (next) {
  // Ensure creator is in participants
  if (this.isNew && !this.participants.includes(this.createdBy)) {
    this.participants.push(this.createdBy);
  }

  // Ensure creator is admin for group chats
  if (
    this.isNew &&
    this.type === "group" &&
    !this.admins.includes(this.createdBy)
  ) {
    this.admins.push(this.createdBy);
  }

  // Set name for private chats if not provided
  if (this.type === "private" && (!this.name || this.name === "Private Chat")) {
    // Will be set properly when populated with user data
    this.name = "Private Chat";
  }

  next();
});

// Pre-remove middleware
chatRoomSchema.pre("remove", async function (next) {
  try {
    // Delete all messages in this chat room
    const Message = mongoose.model("Message");
    await Message.deleteMany({ chatRoom: this._id });

    next();
  } catch (error) {
    next(error);
  }
});

const ChatRoom = mongoose.model("ChatRoom", chatRoomSchema);

module.exports = ChatRoom;
