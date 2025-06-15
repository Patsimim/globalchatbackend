const express = require("express");
const router = express.Router();
const {
  register,
  login,
  getProfile,
} = require("../controllers/AuthController");
const { authenticateToken } = require("../middlewares/AuthMiddleware");

// POST /api/auth/register
router.post("/register", register);

// POST /api/auth/login
router.post("/login", login);

// GET /api/auth/profile (protected route)
router.get("/profile", authenticateToken, getProfile);

// GET /api/auth/me (alternative profile route)
router.get("/me", authenticateToken, getProfile);

module.exports = router;
