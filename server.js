// server.js - Fixed server setup with correct file paths
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const socketIo = require("socket.io");

const app = express();
const server = http.createServer(app);

// Environment validation
const requiredEnvVars = ["MONGO_URI", "JWT_SECRET"];
for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

console.log(`🚀 Starting GlobalChat server in ${NODE_ENV} mode...`);

/**
 * Database Connection
 */
async function connectDatabase() {
  try {
    const mongoOptions = {
      maxPoolSize: 10,
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    };

    await mongoose.connect(process.env.MONGO_URI, mongoOptions);
    console.log("✅ MongoDB connected successfully");

    // Database event listeners
    mongoose.connection.on("error", (err) => {
      console.error("❌ MongoDB connection error:", err);
    });

    mongoose.connection.on("disconnected", () => {
      console.warn("⚠️ MongoDB disconnected");
    });

    mongoose.connection.on("reconnected", () => {
      console.log("🔄 MongoDB reconnected");
    });
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    process.exit(1);
  }
}

/**
 * Middleware Setup
 */
function setupMiddleware() {
  // CORS configuration
  const corsOptions = {
    origin: function (origin, callback) {
      const allowedOrigins = [
        "http://localhost:4200",
        "http://localhost:3000",
        "http://localhost:3001",
        process.env.FRONTEND_URL,
      ].filter(Boolean);

      // Allow requests with no origin (mobile apps, etc.)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  };

  app.use(cors(corsOptions));

  // Body parsing
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: true, limit: "10mb" }));

  // Request logging
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      console.log(
        `${req.method} ${req.originalUrl} - ${res.statusCode} (${duration}ms)`
      );
    });
    next();
  });

  console.log("✅ Middleware setup complete");
}

/**
 * Socket.IO Setup
 */
function setupSocketIO() {
  const io = socketIo(server, {
    cors: {
      origin: [
        "http://localhost:4200",
        "http://localhost:3000",
        "http://localhost:3001",
      ],
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ["websocket", "polling"],
    allowEIO3: true,
  });

  // Try to initialize socket handlers
  let socketUtils = null;
  try {
    const socketHandler = require("./src/sockets/SocketHandler");
    socketUtils = socketHandler(io);
    console.log("✅ Socket handlers loaded successfully");
  } catch (error) {
    console.warn("⚠️ Socket handlers not available:", error.message);
    // Create minimal socket utils for compatibility
    socketUtils = {
      getOnlineUsersCount: () => 0,
      sendToUser: () => false,
      broadcastOnlineUsers: () => {},
      connectedUsers: new Map(),
      roomUsers: new Map(),
    };
  }

  // Add socket utilities to app for access in routes
  app.set("socketUtils", socketUtils);
  app.set("io", io);

  console.log("✅ Socket.IO setup complete");
  return { io, socketUtils };
}

/**
 * Routes Setup
 */
function setupRoutes() {
  console.log("🔍 Setting up routes...");

  // Health check routes (no auth required)
  app.get("/", (req, res) => {
    res.json({
      message: "GlobalChat Backend API is running!",
      version: "2.0.0",
      environment: NODE_ENV,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/api/health", (req, res) => {
    const socketUtils = app.get("socketUtils");
    res.json({
      success: true,
      message: "GlobalChat Backend API is running!",
      version: "2.0.0",
      environment: NODE_ENV,
      database:
        mongoose.connection.readyState === 1 ? "connected" : "disconnected",
      onlineUsers: socketUtils ? socketUtils.getOnlineUsersCount() : 0,
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  });

  // Try to load authentication routes
  try {
    console.log("🔍 Loading auth routes...");
    const authRoutes = require("./src/routes/user.routes");
    app.use("/api/auth", authRoutes);
    console.log("✅ Auth routes loaded successfully");
  } catch (error) {
    console.error("❌ Error loading auth routes:", error.message);
    // Try alternative path
    try {
      const authRoutes = require("./routes/auth");
      app.use("/api/auth", authRoutes);
      console.log("✅ Auth routes loaded from alternative path");
    } catch (altError) {
      console.error("❌ Could not load auth routes from any location");
    }
  }

  // Try to load chat routes with authentication
  try {
    console.log("🔍 Loading chat routes...");
    const { authenticateToken } = require("./src/middlewares/AuthMiddleware");
    const chatRoutes = require("./src/routes/chat.routes");
    app.use("/api/chat", authenticateToken, chatRoutes);
    console.log("✅ Chat routes loaded successfully");
  } catch (error) {
    console.warn("⚠️ Chat routes not available:", error.message);
  }

  // API status endpoint (requires auth if available)
  try {
    const { authenticateToken } = require("./src/middlewares/AuthMiddleware");
    app.get("/api/status", authenticateToken, (req, res) => {
      const socketUtils = app.get("socketUtils");
      res.json({
        success: true,
        user: req.user ? req.user.getChatProfile() : null,
        server: {
          onlineUsers: socketUtils ? socketUtils.getOnlineUsersCount() : 0,
          serverTime: new Date().toISOString(),
          uptime: process.uptime(),
        },
      });
    });
    console.log("✅ Protected status endpoint setup");
  } catch (error) {
    console.warn("⚠️ Protected status endpoint not available");
  }

  // Admin routes (if models are available)
  try {
    const { authenticateToken } = require("./src/middlewares/AuthMiddleware");
    const User = require("./src/models/User");
    const ChatRoom = require("./src/models/ChatRoom");
    const { Message } = require("./src/models/Messages");

    app.get("/api/admin/stats", authenticateToken, async (req, res) => {
      try {
        // Check admin permissions
        if (!req.user.isAdmin && req.user.role !== "admin") {
          return res.status(403).json({
            success: false,
            message: "Admin access required",
          });
        }

        const socketUtils = app.get("socketUtils");

        const [
          totalUsers,
          onlineUsers,
          totalGroups,
          totalMessages,
          todayMessages,
        ] = await Promise.all([
          User.countDocuments(),
          User.countDocuments({ isOnline: true }),
          ChatRoom.countDocuments({ type: "group" }),
          Message.countDocuments(),
          Message.countDocuments({
            createdAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
          }),
        ]);

        res.json({
          success: true,
          stats: {
            users: {
              total: totalUsers,
              online: onlineUsers,
              connectedSockets: socketUtils
                ? socketUtils.getOnlineUsersCount()
                : 0,
            },
            groups: {
              total: totalGroups,
            },
            messages: {
              total: totalMessages,
              today: todayMessages,
            },
            server: {
              uptime: process.uptime(),
              memory: process.memoryUsage(),
              environment: NODE_ENV,
            },
          },
        });
      } catch (error) {
        console.error("Error fetching admin stats:", error);
        res.status(500).json({
          success: false,
          message: "Failed to fetch statistics",
        });
      }
    });
    console.log("✅ Admin routes setup");
  } catch (error) {
    console.warn("⚠️ Admin routes not available:", error.message);
  }

  console.log("✅ Routes setup complete");
}

/**
 * Error Handlers
 */
function setupErrorHandlers() {
  // 404 handler
  app.use("*", (req, res) => {
    res.status(404).json({
      success: false,
      message: "Route not found",
      requestedPath: req.originalUrl,
      availableEndpoints: [
        "GET /",
        "GET /api/health",
        "POST /api/auth/register",
        "POST /api/auth/login",
        "GET /api/chat/world/messages",
        "GET /api/chat/groups",
        "GET /api/chat/private",
      ],
    });
  });

  // Global error handler
  app.use((err, req, res, next) => {
    console.error("❌ Global error:", err);

    // Mongoose validation errors
    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map((e) => e.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors,
      });
    }

    // Mongoose duplicate key errors
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`,
        code: "DUPLICATE_FIELD",
      });
    }

    // JWT errors
    if (err.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid token",
        code: "INVALID_TOKEN",
      });
    }

    // Default error response
    const statusCode = err.statusCode || 500;
    res.status(statusCode).json({
      success: false,
      message: err.message || "Internal server error",
      code: err.code || "INTERNAL_ERROR",
      ...(NODE_ENV === "development" && {
        stack: err.stack,
        details: err,
      }),
    });
  });

  console.log("✅ Error handlers setup complete");
}

/**
 * Graceful Shutdown
 */
function setupGracefulShutdown(server, io) {
  const gracefulShutdown = (signal) => {
    console.log(`\n📤 Received ${signal}. Starting graceful shutdown...`);

    server.close((err) => {
      if (err) {
        console.error("❌ Error during server shutdown:", err);
        process.exit(1);
      }

      console.log("🛑 HTTP server closed");

      if (io) {
        io.close(() => {
          console.log("🛑 Socket.IO server closed");
        });
      }

      mongoose.connection.close(false, () => {
        console.log("🛑 MongoDB connection closed");
        console.log("✅ Graceful shutdown completed");
        process.exit(0);
      });
    });

    // Force exit after timeout
    setTimeout(() => {
      console.error(
        "❌ Could not close connections in time, forcefully shutting down"
      );
      process.exit(1);
    }, 10000);
  };

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  process.on("uncaughtException", (err) => {
    console.error("❌ Uncaught Exception:", err);
    gracefulShutdown("uncaughtException");
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
    gracefulShutdown("unhandledRejection");
  });
}

/**
 * Start Server
 */
async function startServer() {
  try {
    await connectDatabase();
    setupMiddleware();
    const { io, socketUtils } = setupSocketIO();
    setupRoutes();
    setupErrorHandlers();
    setupGracefulShutdown(server, io);

    server.listen(PORT, () => {
      console.log(`\n🎉 GlobalChat server successfully started!`);
      console.log(`📍 Server running on http://localhost:${PORT}`);
      console.log(`🏥 Health check: http://localhost:${PORT}/api/health`);
      console.log(`🔐 Auth endpoints: http://localhost:${PORT}/api/auth/`);
      console.log(`💬 Chat endpoints: http://localhost:${PORT}/api/chat/`);
      console.log(`🔌 Socket.IO ready for connections`);
      console.log(`🌍 Environment: ${NODE_ENV}`);
      console.log(`📊 Process ID: ${process.pid}`);
      console.log(`⚡ Ready to handle requests!\n`);
    });

    // Log periodic stats
    setInterval(() => {
      const memUsage = process.memoryUsage();
      console.log(
        `📊 Server stats: ${socketUtils.getOnlineUsersCount()} users online, ` +
          `${Math.round(memUsage.rss / 1024 / 1024)}MB memory, ` +
          `${Math.round(process.uptime())}s uptime`
      );
    }, 300000); // Every 5 minutes
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
}

// Start the server
startServer();

// Export for testing
module.exports = { app, server };
