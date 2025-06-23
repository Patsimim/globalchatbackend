// scripts/migrateUsers.js - Fix existing users using firstName + lastName
require("dotenv").config();

const mongoose = require("mongoose");
const User = require("../models/User");

const migrateUsers = async () => {
  try {
    console.log("🔄 Starting user migration...");

    // Connect to database
    await mongoose.connect(process.env.MONGO_URI);

    // Find users missing username or displayName
    const usersToFix = await User.find({
      $or: [
        { username: { $exists: false } },
        { username: null },
        { username: "" },
        { displayName: { $exists: false } },
        { displayName: null },
        { displayName: "" },
      ],
    }).select("+password"); // Include password to see full document

    console.log(`📊 Found ${usersToFix.length} users to migrate`);

    for (let user of usersToFix) {
      console.log(`🔧 Fixing user: ${user.email}`);

      const updates = {};

      // Generate username from firstName + lastName
      if (!user.username && user.firstName && user.lastName) {
        const fullName = `${user.firstName}${user.lastName}`.toLowerCase();
        // Remove spaces and special chars, keep only alphanumeric and underscore
        const cleanUsername = fullName.replace(/[^a-zA-Z0-9_]/g, "");
        updates.username = cleanUsername;
      } else if (!user.username) {
        // Fallback to email if no firstName/lastName
        const emailUsername = user.email.split("@")[0].toLowerCase();
        const cleanUsername = emailUsername.replace(/[^a-zA-Z0-9_]/g, "");
        updates.username = cleanUsername;
      }

      // Generate displayName from firstName + lastName
      if (!user.displayName && user.firstName && user.lastName) {
        updates.displayName = `${user.firstName} ${user.lastName}`;
      } else if (!user.displayName) {
        // Fallback to username or email
        updates.displayName = user.username || user.email.split("@")[0];
      }

      // Update the user
      await User.findByIdAndUpdate(user._id, updates, { runValidators: false });

      console.log(`✅ Updated user ${user.email}:`, updates);
    }

    console.log("🎉 Migration completed successfully!");
    process.exit(0);
  } catch (error) {
    console.error("❌ Migration failed:", error);
    process.exit(1);
  }
};

// Run if called directly
if (require.main === module) {
  migrateUsers();
}

module.exports = migrateUsers;
