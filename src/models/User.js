// models/User.js (Enhanced version that extends your existing User model)
const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    firstName: {
      type: String,
      required: [true, "First name is required"],
      trim: true,
      maxlength: [50, "First name cannot exceed 50 characters"],
    },
    lastName: {
      type: String,
      required: [true, "Last name is required"],
      trim: true,
      maxlength: [50, "Last name cannot exceed 50 characters"],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, "Please provide a valid email"],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters"],
    },
    country: {
      type: String,
      required: [true, "Country is required"],
      trim: true,
      maxlength: [100, "Country name cannot exceed 100 characters"],
    },

    // Chat-specific fields
    avatar: {
      type: String,
      default: null,
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    socketId: {
      type: String,
      default: null,
    },
    joinedGroups: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ChatRoom",
      },
    ],
    blockedUsers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],
    settings: {
      notifications: {
        type: Boolean,
        default: true,
      },
      soundEnabled: {
        type: Boolean,
        default: true,
      },
      theme: {
        type: String,
        enum: ["light", "dark"],
        default: "light",
      },
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for faster queries
userSchema.index({ email: 1 });
userSchema.index({ isOnline: 1 });
userSchema.index({ country: 1 });
userSchema.index({ firstName: 1, lastName: 1 });

// Virtual for full name
userSchema.virtual("fullName").get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Ensure virtual fields are serialized
userSchema.set("toJSON", {
  virtuals: true,
  transform: function (doc, ret) {
    delete ret.password;
    delete ret.__v;
    return ret;
  },
});

// Hash password before saving (only if modified)
userSchema.pre("save", async function (next) {
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Instance method to check password
userSchema.methods.comparePassword = async function (candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    throw error;
  }
};

// Instance method to get public profile
userSchema.methods.getPublicProfile = function () {
  const user = this.toObject();
  delete user.password;
  delete user.socketId;
  delete user.blockedUsers;
  return user;
};

// Instance method to get chat profile (minimal info for chat)
userSchema.methods.getChatProfile = function () {
  return {
    id: this._id,
    firstName: this.firstName,
    lastName: this.lastName,
    country: this.country,
    isOnline: this.isOnline,
    lastSeen: this.lastSeen,
    avatar: this.avatar,
  };
};

// Static method to find online users
userSchema.statics.findOnlineUsers = function () {
  return this.find({ isOnline: true })
    .select("firstName lastName country isOnline lastSeen avatar")
    .sort({ lastSeen: -1 });
};

// Static method to search users
userSchema.statics.searchUsers = function (query, excludeUserId) {
  const searchRegex = new RegExp(query, "i");
  return this.find({
    _id: { $ne: excludeUserId },
    $or: [
      { firstName: searchRegex },
      { lastName: searchRegex },
      { email: searchRegex },
    ],
  })
    .select("firstName lastName email country isOnline avatar")
    .limit(20);
};

// Update last seen when user goes offline
userSchema.methods.updateLastSeen = function () {
  this.lastSeen = new Date();
  this.isOnline = false;
  this.socketId = null;
  return this.save();
};

// Set user online
userSchema.methods.setOnline = function (socketId) {
  this.isOnline = true;
  this.socketId = socketId;
  this.lastSeen = new Date();
  return this.save();
};

// Add user to group
userSchema.methods.joinGroup = function (groupId) {
  if (!this.joinedGroups.includes(groupId)) {
    this.joinedGroups.push(groupId);
    return this.save();
  }
  return Promise.resolve(this);
};

// Remove user from group
userSchema.methods.leaveGroup = function (groupId) {
  this.joinedGroups = this.joinedGroups.filter((id) => !id.equals(groupId));
  return this.save();
};

// Block user
userSchema.methods.blockUser = function (userId) {
  if (!this.blockedUsers.includes(userId)) {
    this.blockedUsers.push(userId);
    return this.save();
  }
  return Promise.resolve(this);
};

// Unblock user
userSchema.methods.unblockUser = function (userId) {
  this.blockedUsers = this.blockedUsers.filter((id) => !id.equals(userId));
  return this.save();
};

// Check if user is blocked
userSchema.methods.isBlocked = function (userId) {
  return this.blockedUsers.some((id) => id.equals(userId));
};

module.exports = mongoose.model("User", userSchema);
