import prisma from "../util/prisma.js";
import bcrypt from "bcryptjs";

const seedAdmin = async () => {
  const emailAdmin = process.env.SEED_ADMIN_EMAIL;
  const nameAdmin = process.env.SEED_ADMIN_NAME || "Admin";
  const phoneAdmin = process.env.SEED_ADMIN_PHONE || "0000000000";
  const passwordAdmin = process.env.SEED_ADMIN_PASSWORD;
  const roleAdmin = "admin";

  if (!emailAdmin || !passwordAdmin) {
    throw new Error(
      "SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD env vars are required to seed the admin account"
    );
  }

  const hashedPassword = await bcrypt.hash(passwordAdmin, 10);

  await prisma.admin.upsert({
    where: { email: emailAdmin },
    update: {},
    create: {
      name: nameAdmin,
      email: emailAdmin,
      password: hashedPassword,
      phone: phoneAdmin,
      status: "ACTIVE",
      role: roleAdmin
    },
  });
  console.log("Admin seeded successfully");
};

try {
  await seedAdmin();
} catch (error) {
  console.error("Error seeding admin: ", error);
} finally {
  await prisma.$disconnect();
}
