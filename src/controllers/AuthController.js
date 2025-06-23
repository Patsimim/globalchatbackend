// src/controllers/AuthController.js - Modified to auto-generate username
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");
const { generateToken } = require("../middlewares/AuthMiddleware"); // Use existing function

/**
 * Generate a unique username from first and last name
 */
const generateUsername = async (firstName, lastName) => {
  // Create base username from first + last name
  const baseUsername = (firstName + lastName)
    .toLowerCase()
    .replace(/[^a-zA-Z0-9]/g, "") // Remove special characters
    .trim();

  let username = baseUsername;
  let counter = 1;

  // Keep checking until we find an available username
  while (await User.findOne({ username: username.toLowerCase() })) {
    username = `${baseUsername}${counter}`;
    counter++;
  }

  return username;
};

/**
 * Register a new user - UPDATED to auto-generate username
 */
const register = async (req, res) => {
  try {
    console.log("📝 Register attempt with data:", {
      email: req.body.email,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      country: req.body.country,
      passwordProvided: !!req.body.password,
    });

    // Add full request body debug
    console.log("📝 Full request body:", JSON.stringify(req.body, null, 2));

    const { firstName, lastName, email, country, password } = req.body;

    // Validation - username is no longer required from client
    if (!firstName || !lastName || !email || !country || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields are required",
        missing: {
          firstName: !firstName,
          lastName: !lastName,
          email: !email,
          country: !country,
          password: !password,
        },
      });
    }

    // Email validation - Updated to match your User model regex
    const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address",
      });
    }

    // Password validation (minimum 6 characters)
    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 6 characters long",
      });
    }

    // Check if email already exists
    const existingUser = await User.findOne({
      email: email.toLowerCase(),
    });

    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "User with this email already exists",
      });
    }

    // Auto-generate unique username
    const generatedUsername = await generateUsername(firstName, lastName);
    console.log("🏷️ Generated username:", generatedUsername);

    // Hash password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(password, saltRounds);

    // Create user with all required fields
    const user = new User({
      username: generatedUsername,
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      displayName: `${firstName.trim()} ${lastName.trim()}`, // Required field
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      country: country.trim(),
      isOnline: true, // Set as online on registration
      lastSeen: new Date(),
      lastLogin: new Date(),
    });

    await user.save();

    // Generate JWT token using middleware function
    const token = generateToken(user._id, { expiresIn: "24h" });

    // Return success response (password excluded by model's toJSON transform)
    const userResponse = {
      id: user._id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      country: user.country,
      displayName: user.displayName,
      isOnline: user.isOnline,
      createdAt: user.createdAt,
    };

    console.log(
      "✅ User registered successfully:",
      user.email,
      "with username:",
      user.username
    );

    res.status(201).json({
      success: true,
      message: "User registered successfully",
      user: userResponse,
      token,
    });
  } catch (error) {
    console.error("❌ Registration error:", error);

    // Handle duplicate key error
    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(409).json({
        success: false,
        message: `${field} already exists`,
      });
    }

    // Handle validation errors
    if (error.name === "ValidationError") {
      const errors = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors,
      });
    }

    res.status(500).json({
      success: false,
      message: "Registration failed",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

/**
 * Login user - FIXED to include password field
 */
const login = async (req, res) => {
  try {
    console.log("🔑 Login attempt with data:", {
      email: req.body.email,
      passwordProvided: !!req.body.password,
    });

    const { email, password } = req.body;

    // Input validation
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
        missing: {
          email: !email,
          password: !password,
        },
      });
    }

    // Validate email format - Updated to match your User model regex
    const emailRegex = /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address",
      });
    }

    // CRITICAL FIX: Find user by email and EXPLICITLY include password field
    const user = await User.findOne({
      email: email.toLowerCase().trim(),
    }).select("+password"); // This + sign explicitly includes the password field

    if (!user) {
      console.log("❌ User not found:", email);
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    console.log("👤 User found:", {
      id: user._id,
      email: user.email,
      username: user.username,
      hasPassword: !!user.password,
      passwordLength: user.password ? user.password.length : 0,
    });

    // Check if user has a password (important check!)
    if (!user.password) {
      console.error("❌ User has no password stored:", user.email);
      return res.status(500).json({
        success: false,
        message: "Account configuration error. Please contact support.",
      });
    }

    // Check if user is banned
    if (user.isBannedNow && user.isBannedNow()) {
      console.log("❌ User is banned:", user.email);
      return res.status(403).json({
        success: false,
        message: "Account is banned",
        banReason: user.banReason,
        banExpiresAt: user.banExpiresAt,
      });
    }

    // Compare password - THIS IS NOW FIXED
    console.log("🔐 Comparing passwords...");
    console.log(
      "Password from request:",
      password ? "PROVIDED" : "NOT PROVIDED"
    );
    console.log("Stored password hash:", user.password ? "EXISTS" : "MISSING");

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      console.log("❌ Invalid password for user:", email);
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });
    }

    // Update user's online status and last login
    user.isOnline = true;
    user.lastSeen = new Date();
    user.lastLogin = new Date();
    await user.save();

    // Generate JWT token using middleware function
    const token = generateToken(user._id, { expiresIn: "24h" });

    // Return success response (don't include password)
    const userResponse = {
      id: user._id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      country: user.country,
      displayName: user.displayName,
      isOnline: user.isOnline,
      lastSeen: user.lastSeen,
      lastLogin: user.lastLogin,
      role: user.role,
      createdAt: user.createdAt,
    };

    console.log("✅ Login successful for user:", user.email);

    res.json({
      success: true,
      message: "Login successful",
      user: userResponse,
      token,
    });
  } catch (error) {
    console.error("❌ Login error:", error);

    res.status(500).json({
      success: false,
      message: "Login failed",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

/**
 * Get user profile - UPDATED to work with User model
 */
const getProfile = async (req, res) => {
  try {
    console.log(
      "👤 Profile request for user:",
      req.user?.userId || req.user?.id
    );

    // The user should be attached by the authentication middleware
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "User not authenticated",
      });
    }

    // Get fresh user data from database
    const userId = req.user.userId || req.user.id || req.user._id;
    const user = await User.findById(userId).select("-password");

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    const userResponse = {
      id: user._id,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      country: user.country,
      displayName: user.displayName,
      avatar: user.avatar,
      profilePicture: user.profilePicture,
      isOnline: user.isOnline,
      lastSeen: user.lastSeen,
      lastLogin: user.lastLogin,
      role: user.role,
      isAdmin: user.isAdmin,
      joinedGroups: user.joinedGroups,
      settings: user.settings,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };

    console.log("✅ Profile retrieved for user:", user.email);

    res.json({
      success: true,
      user: userResponse,
    });
  } catch (error) {
    console.error("❌ Profile error:", error);

    res.status(500).json({
      success: false,
      message: "Failed to get profile",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

/**
 * Logout user (optional - client-side can just delete token)
 */
const logout = async (req, res) => {
  try {
    console.log(
      "🚪 Logout request for user:",
      req.user?.userId || req.user?.id
    );

    if (req.user) {
      const userId = req.user.userId || req.user.id || req.user._id;

      // Update user's online status
      await User.findByIdAndUpdate(userId, {
        isOnline: false,
        lastSeen: new Date(),
      });

      console.log("✅ User logged out:", userId);
    }

    res.json({
      success: true,
      message: "Logged out successfully",
    });
  } catch (error) {
    console.error("❌ Logout error:", error);

    res.status(500).json({
      success: false,
      message: "Logout failed",
      error:
        process.env.NODE_ENV === "development"
          ? error.message
          : "Internal server error",
    });
  }
};

module.exports = {
  register,
  login,
  getProfile,
  logout,
};
