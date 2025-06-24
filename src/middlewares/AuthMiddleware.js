// middleware/auth.js
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET is not defined in environment variables");
  process.exit(1);
}

/**
 * Generate JWT token with enhanced payload
 */
const generateToken = (userId, options = {}) => {
  const payload = {
    userId: userId.toString(),
    iat: Math.floor(Date.now() / 1000),
    ...options.extraPayload,
  };

  const tokenOptions = {
    expiresIn: options.expiresIn || process.env.JWT_EXPIRES_IN || "7d",
    issuer: "globalchat-api",
    audience: "globalchat-users",
    ...options.tokenOptions,
  };

  return jwt.sign(payload, JWT_SECRET, tokenOptions);
};

/**
 * Enhanced authentication middleware for HTTP requests
 */
const authenticateToken = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Access token required",
        code: "NO_TOKEN",
      });
    }

    // Verify and decode token
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: "globalchat-api",
      audience: "globalchat-users",
    });

    // Get user from database
    const userId = decoded.userId || decoded.id;
    const user = await User.findById(userId).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid token. User not found.",
        code: "USER_NOT_FOUND",
      });
    }

    // Check if user account is active/not banned
    if (user.status && user.status === "banned") {
      return res.status(403).json({
        success: false,
        message: "Account has been suspended",
        code: "ACCOUNT_SUSPENDED",
      });
    }

    // Add user to request object with compatibility
    req.user = {
      ...user.toObject(),
      userId: user._id,
      id: user._id,
      tokenPayload: decoded,
    };

    // Update last activity if more than 5 minutes since last update
    const lastActivity = user.lastSeen || new Date(0);
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    if (lastActivity < fiveMinutesAgo) {
      // Don't await this to avoid slowing down requests
      User.findByIdAndUpdate(userId, {
        lastSeen: new Date(),
        $inc: { apiRequestCount: 1 },
      }).catch(console.error);
    }

    next();
  } catch (error) {
    console.error("Authentication error:", error);
    return handleAuthError(error, res);
  }
};

/**
 * Socket authentication middleware
 */
const authenticateSocket = async (socket, next) => {
  try {
    const token = extractSocketToken(socket);

    if (!token) {
      return next(new Error("Authentication error: No token provided"));
    }

    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: "globalchat-api",
      audience: "globalchat-users",
    });

    // Get user
    const userId = decoded.userId || decoded.id;
    const user = await User.findById(userId).select("-password");

    if (!user) {
      return next(new Error("Authentication failed: User not found"));
    }

    // Check account status
    if (user.status && user.status === "banned") {
      return next(new Error("Account suspended"));
    }

    // Add user data to socket
    socket.userId = user._id.toString();
    socket.user = user;
    socket.tokenPayload = decoded;

    // Log connection attempt
    console.log(
      `🔐 Socket auth successful: ${user.firstName} ${user.lastName} (${userId})`
    );

    next();
  } catch (error) {
    console.error("Socket authentication error:", error);

    let errorMessage = "Authentication failed";

    if (error.name === "JsonWebTokenError") {
      errorMessage = "Invalid token format";
    } else if (error.name === "TokenExpiredError") {
      errorMessage = "Token has expired";
    } else if (error.name === "NotBeforeError") {
      errorMessage = "Token not yet valid";
    }

    next(new Error(errorMessage));
  }
};

/**
 * Optional authentication middleware (doesn't fail if no token)
 */
const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);

    if (!token) {
      req.user = null;
      return next();
    }

    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: "globalchat-api",
      audience: "globalchat-users",
    });

    const userId = decoded.userId || decoded.id;
    const user = await User.findById(userId).select("-password");

    req.user = user
      ? {
          ...user.toObject(),
          userId: user._id,
          id: user._id,
          tokenPayload: decoded,
        }
      : null;

    next();
  } catch (error) {
    // Silently fail for optional auth
    req.user = null;
    next();
  }
};

/**
 * Admin authentication middleware
 */
const requireAdmin = async (req, res, next) => {
  try {
    // First run normal authentication
    await new Promise((resolve, reject) => {
      authenticateToken(req, res, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });

    // Check if user is admin
    if (!req.user.isAdmin && !req.user.role === "admin") {
      return res.status(403).json({
        success: false,
        message: "Admin access required",
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Rate limiting middleware factory
 */
const createRateLimit = (options = {}) => {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    maxRequests = 100,
    message = "Too many requests",
    skipSuccessfulRequests = false,
  } = options;

  const requests = new Map();

  return (req, res, next) => {
    const key = req.user?.id || req.ip;
    const now = Date.now();
    const windowStart = now - windowMs;

    // Get or create request log for this key
    if (!requests.has(key)) {
      requests.set(key, []);
    }

    const userRequests = requests.get(key);

    // Remove expired requests
    const validRequests = userRequests.filter((time) => time > windowStart);
    requests.set(key, validRequests);

    // Check if over limit
    if (validRequests.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        message,
        code: "RATE_LIMITED",
        retryAfter: Math.ceil((validRequests[0] + windowMs - now) / 1000),
      });
    }

    // Add current request
    validRequests.push(now);

    // Add rate limit headers
    res.set({
      "X-RateLimit-Limit": maxRequests,
      "X-RateLimit-Remaining": Math.max(0, maxRequests - validRequests.length),
      "X-RateLimit-Reset": new Date(validRequests[0] + windowMs).toISOString(),
    });

    next();
  };
};

/**
 * Refresh token middleware
 */
const refreshToken = async (req, res, next) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({
        success: false,
        message: "Refresh token required",
        code: "NO_REFRESH_TOKEN",
      });
    }

    // Verify refresh token (you might store these differently)
    const decoded = jwt.verify(refreshToken, JWT_SECRET + "_REFRESH");
    const user = await User.findById(decoded.userId).select("-password");

    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid refresh token",
        code: "INVALID_REFRESH_TOKEN",
      });
    }

    // Generate new access token
    const newToken = generateToken(user._id);
    const newRefreshToken = generateRefreshToken(user._id);

    req.newTokens = {
      accessToken: newToken,
      refreshToken: newRefreshToken,
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid refresh token",
      code: "REFRESH_TOKEN_INVALID",
    });
  }
};

/**
 * Utility Functions
 */

/**
 * Extract token from request headers
 */
function extractToken(req) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7); // Remove "Bearer " prefix
  }

  // Fallback to query parameter (less secure, only for development)
  if (process.env.NODE_ENV === "development" && req.query.token) {
    return req.query.token;
  }

  return null;
}

/**
 * Extract token from socket handshake
 */
function extractSocketToken(socket) {
  // Try auth object first (recommended)
  if (socket.handshake.auth && socket.handshake.auth.token) {
    return socket.handshake.auth.token;
  }

  // Fallback to query parameters
  if (socket.handshake.query && socket.handshake.query.token) {
    return socket.handshake.query.token;
  }

  // Try headers as last resort
  const authHeader = socket.handshake.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  return null;
}

/**
 * Handle authentication errors with appropriate responses
 */
function handleAuthError(error, res) {
  const errorMap = {
    JsonWebTokenError: {
      status: 401,
      message: "Invalid token format",
      code: "INVALID_TOKEN",
    },
    TokenExpiredError: {
      status: 401,
      message: "Token has expired",
      code: "TOKEN_EXPIRED",
    },
    NotBeforeError: {
      status: 401,
      message: "Token not yet valid",
      code: "TOKEN_NOT_ACTIVE",
    },
  };

  const errorInfo = errorMap[error.name] || {
    status: 500,
    message: "Authentication error",
    code: "AUTH_ERROR",
  };

  return res.status(errorInfo.status).json({
    success: false,
    message: errorInfo.message,
    code: errorInfo.code,
    ...(process.env.NODE_ENV === "development" && {
      debug: error.message,
      stack: error.stack,
    }),
  });
}

/**
 * Generate refresh token
 */
function generateRefreshToken(userId) {
  return jwt.sign(
    { userId: userId.toString(), type: "refresh" },
    JWT_SECRET + "_REFRESH",
    {
      expiresIn: "30d",
      issuer: "globalchat-api",
      audience: "globalchat-users",
    }
  );
}

/**
 * Verify token without throwing (for internal use)
 */
async function verifyTokenSafe(token) {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: "globalchat-api",
      audience: "globalchat-users",
    });

    const user = await User.findById(decoded.userId || decoded.id).select(
      "-password"
    );

    return { valid: true, user, decoded };
  } catch (error) {
    return { valid: false, error };
  }
}

/**
 * Create authentication package for user login
 */
function createAuthPackage(user, options = {}) {
  const accessToken = generateToken(user._id, options);
  const refreshToken = generateRefreshToken(user._id);

  return {
    user: user.getPublicProfile(),
    tokens: {
      accessToken,
      refreshToken,
      expiresIn: options.expiresIn || "7d",
    },
    permissions: getUserPermissions(user),
  };
}

/**
 * Get user permissions (can be extended)
 */
function getUserPermissions(user) {
  const basePermissions = ["chat:send", "chat:read"];

  if (user.isAdmin || user.role === "admin") {
    basePermissions.push("admin:read", "admin:write", "user:manage");
  }

  if (user.role === "moderator") {
    basePermissions.push("chat:moderate", "user:timeout");
  }

  return basePermissions;
}

/**
 * Middleware to check specific permissions
 */
const requirePermission = (permission) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
        code: "NO_AUTH",
      });
    }

    const userPermissions = getUserPermissions(req.user);

    if (!userPermissions.includes(permission)) {
      return res.status(403).json({
        success: false,
        message: `Permission '${permission}' required`,
        code: "INSUFFICIENT_PERMISSIONS",
      });
    }

    next();
  };
};

/**
 * Enhanced socket authentication with error details
 */
const authenticateSocketEnhanced = async (socket, next) => {
  const startTime = Date.now();

  try {
    await authenticateSocket(socket, next);

    // Log successful authentication
    const duration = Date.now() - startTime;
    console.log(
      `✅ Socket auth completed in ${duration}ms for user ${socket.userId}`
    );
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Socket auth failed in ${duration}ms:`, error.message);

    // Emit error to client before disconnecting
    socket.emit("auth_error", {
      message: error.message,
      code: "AUTH_FAILED",
      timestamp: new Date().toISOString(),
    });

    setTimeout(() => socket.disconnect(), 1000); // Give time for error to be received
  }
};

module.exports = {
  // Core auth functions
  generateToken,
  generateRefreshToken,
  authenticateToken,
  authenticateSocket,
  authenticateSocketEnhanced,
  optionalAuth,

  // Admin and permissions
  requireAdmin,
  requirePermission,

  // Rate limiting
  createRateLimit,

  // Token refresh
  refreshToken,

  // Utilities
  verifyTokenSafe,
  createAuthPackage,
  getUserPermissions,
  extractToken,
  extractSocketToken,

  // Constants
  JWT_SECRET,
};
