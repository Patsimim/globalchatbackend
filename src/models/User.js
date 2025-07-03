const mongoose = require("mongoose");

const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: [true, "Username is required"],
      trim: true,
      minlength: [3, "Username must be at least 3 characters long"],
      maxlength: [30, "Username must not exceed 30 characters"],
      match: [
        /^[a-zA-Z0-9_]+$/,
        "Username can only contain letters, numbers, and underscores",
      ],
    },
    email: {
      type: String,
      required: [true, "Email is required"],
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        "Please provide a valid email",
      ],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [6, "Password must be at least 6 characters long"],
      select: false, // Don't include password in queries by default
    },
    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [50, "Display name must not exceed 50 characters"],
    },
    // Additional fields for chat functionality
    firstName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [50, "First name must not exceed 50 characters"],
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
      maxlength: [50, "Last name must not exceed 50 characters"],
    },
    country: {
      type: String,
      trim: true,
      maxlength: [100, "Country must not exceed 100 characters"],
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
    profilePicture: {
      type: String,
      default: null,
      validate: {
        validator: function (v) {
          return !v || /^https?:\/\/.+/.test(v);
        },
        message: "Profile picture must be a valid URL",
      },
    },
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastSeen: {
      type: Date,
      default: Date.now,
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    role: {
      type: String,
      enum: ["user", "moderator", "admin"],
      default: "user",
    },
    isAdmin: {
      type: Boolean,
      default: false,
    },
    isBanned: {
      type: Boolean,
      default: false,
    },
    banReason: {
      type: String,
      default: null,
    },
    banExpiresAt: {
      type: Date,
      default: null,
    },
    socketId: {
      type: String,
      default: null,
    },
    // Chat-related fields
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
    // Settings
    settings: {
      theme: {
        type: String,
        enum: ["light", "dark", "auto"],
        default: "auto",
      },
      notifications: {
        email: {
          type: Boolean,
          default: true,
        },
        push: {
          type: Boolean,
          default: true,
        },
        sound: {
          type: Boolean,
          default: true,
        },
      },
      privacy: {
        showOnlineStatus: {
          type: Boolean,
          default: true,
        },
        allowDirectMessages: {
          type: Boolean,
          default: true,
        },
      },
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt
    toJSON: {
      virtuals: true,
      transform: function (doc, ret) {
        delete ret.password;
        return ret;
      },
    },
    toObject: { virtuals: true },
  }
);

// Define indexes separately to avoid duplication
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });
userSchema.index({ isOnline: 1 });
userSchema.index({ lastSeen: 1 });
userSchema.index({ createdAt: 1 });

// Virtual for user's full profile
userSchema.virtual("fullProfile").get(function () {
  return {
    id: this._id,
    username: this.username,
    email: this.email,
    displayName: this.displayName,
    profilePicture: this.profilePicture,
    isOnline: this.isOnline,
    lastSeen: this.lastSeen,
    lastLogin: this.lastLogin,
    role: this.role,
    isAdmin: this.isAdmin,
    settings: this.settings,
    createdAt: this.createdAt,
    updatedAt: this.updatedAt,
  };
});

// Virtual for chat profile (limited info for other users)
userSchema.virtual("chatProfile").get(function () {
  return {
    id: this._id,
    username: this.username,
    displayName: this.displayName,
    profilePicture: this.profilePicture,
    isOnline: this.isOnline,
    lastSeen: this.lastSeen,
    role: this.role,
  };
});

// Instance method to get chat profile
userSchema.methods.getChatProfile = function () {
  return {
    id: this._id,
    username: this.username,
    displayName: this.displayName,
    profilePicture: this.profilePicture,
    isOnline: this.isOnline,
    lastSeen: this.lastSeen,
    role: this.role,
  };
};

// Instance method to check if user is banned
userSchema.methods.isBannedNow = function () {
  if (!this.isBanned) return false;
  if (!this.banExpiresAt) return true; // Permanent ban
  return new Date() < this.banExpiresAt;
};

// Instance method to update online status
userSchema.methods.updateOnlineStatus = function (isOnline, socketId = null) {
  this.isOnline = isOnline;
  this.socketId = socketId;
  if (!isOnline) {
    this.lastSeen = new Date();
  }
  return this.save();
};

// Instance method to set user online (for socket handler)
userSchema.methods.setOnline = function (socketId) {
  this.isOnline = true;
  this.socketId = socketId;
  this.lastSeen = new Date();
  return this.save();
};

// Instance method to update last seen
userSchema.methods.updateLastSeen = function () {
  this.isOnline = false;
  this.socketId = null;
  this.lastSeen = new Date();
  return this.save();
};

// Static method to find online users
userSchema.statics.findOnlineUsers = function () {
  return this.find({ isOnline: true }).select(
    "username displayName profilePicture role firstName lastName country avatar"
  );
};

// Static method to find users by username (case-insensitive search)
userSchema.statics.searchByUsername = function (query, limit = 10) {
  return this.find({
    username: { $regex: query, $options: "i" },
  })
    .select("username displayName profilePicture isOnline role")
    .limit(limit);
};

// Pre-save middleware
userSchema.pre("save", function (next) {
  // Set displayName to username if not provided
  if (!this.displayName) {
    this.displayName = this.username;
  }

  // Update admin status based on role
  this.isAdmin = this.role === "admin";

  next();
});

// Pre-remove middleware to clean up related data
userSchema.pre("remove", function (next) {
  // Here you could add cleanup logic for messages, chat rooms, etc.
  next();
});

const User = mongoose.model("User", userSchema);

module.exports = User;
