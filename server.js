// server.js - Enhanced server setup with Socket.IO integration
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const http = require("http");
const socketIo = require("socket.io");
const helmet = require("helmet"); // Security headers
const compression = require("compression"); // Gzip compression
const rateLimit = require("express-rate-limit"); // Rate limiting

// Import routes and middleware
const authRoutes = require("./routes/auth");
const chatRoutes = require("./routes/chat");
const userRoutes = require("./routes/user");
const { authenticateToken } = require("./middleware/auth");
const socketHandler = require("./sockets/socketHandler");

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
      bufferCommands: false,
      bufferMaxEntries: 0,
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
  // Security middleware
  app.use(
    helmet({
      crossOriginEmbedderPolicy: false, // Needed for Socket.IO
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'", "ws:", "wss:"], // Allow WebSocket connections
        },
      },
    })
  );

  // Compression
  app.use(compression());

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
  app.use(
    express.json({
      limit: "10mb",
      verify: (req, res, buf) => {
        req.rawBody = buf; // Store raw body for webhook verification if needed
      },
    })
  );
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

  // Rate limiting
  const globalRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per windowMs
    message: {
      success: false,
      message: "Too many requests from this IP, please try again later.",
      code: "RATE_LIMITED",
    },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => {
      // Skip rate limiting for health checks
      return req.path === "/api/health" || req.path === "/";
    },
  });

  app.use(globalRateLimit);

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
    allowEIO3: true, // Allow Engine.IO v3 clients
  });

  // Initialize socket handlers
  const socketUtils = socketHandler(io);

  // Add socket utilities to app for access in routes
  app.set("socketUtils", socketUtils);
  app.set("io", io);

  // Monitor socket connections
  io.engine.on("connection_error", (err) => {
    console.error("❌ Socket connection error:", err);
  });

  console.log("✅ Socket.IO setup complete");
  return { io, socketUtils };
}

/**
 * Routes Setup
 */
function setupRoutes() {
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

  // API status endpoint with more details
  app.get("/api/status", authenticateToken, (req, res) => {
    const socketUtils = app.get("socketUtils");
    res.json({
      success: true,
      user: req.user.getChatProfile(),
      server: {
        onlineUsers: socketUtils ? socketUtils.getOnlineUsersCount() : 0,
        serverTime: new Date().toISOString(),
        uptime: process.uptime(),
      },
    });
  });

  // Authentication routes (no auth required)
  app.use("/api/auth", authRoutes);

  // User management routes (auth required)
  if (userRoutes) {
    app.use("/api/users", authenticateToken, userRoutes);
  }

  // Chat routes (auth required)
  app.use("/api/chat", authenticateToken, chatRoutes);

  // Admin routes (admin auth required)
  app.get("/api/admin/stats", authenticateToken, async (req, res) => {
    try {
      // Check admin permissions
      if (!req.user.isAdmin && req.user.role !== "admin") {
        return res.status(403).json({
          success: false,
          message: "Admin access required",
        });
      }

      const User = require("./models/User");
      const ChatRoom = require("./models/ChatRoom");
      const { Message } = require("./models/Message");
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

    // Stop accepting new connections
    server.close((err) => {
      if (err) {
        console.error("❌ Error during server shutdown:", err);
        process.exit(1);
      }

      console.log("🛑 HTTP server closed");

      // Close Socket.IO
      io.close(() => {
        console.log("🛑 Socket.IO server closed");

        // Close database connection
        mongoose.connection.close(false, () => {
          console.log("🛑 MongoDB connection closed");
          console.log("✅ Graceful shutdown completed");
          process.exit(0);
        });
      });
    });

    // Force exit after timeout
    setTimeout(() => {
      console.error(
        "❌ Could not close connections in time, forcefully shutting down"
      );
      process.exit(1);
    }, 10000); // 10 seconds timeout
  };

  // Listen for termination signals
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
  process.on("SIGINT", () => gracefulShutdown("SIGINT"));

  // Handle uncaught exceptions
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
    // Initialize everything in order
    await connectDatabase();
    setupMiddleware();
    const { io, socketUtils } = setupSocketIO();
    setupRoutes();
    setupErrorHandlers();
    setupGracefulShutdown(server, io);

    // Start listening
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
