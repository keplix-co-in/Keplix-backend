import prisma from "../util/prisma.js";
import bcrypt from "bcryptjs";

const seedAdmin = async () => {
<<<<<<< HEAD
  const emailAdmin = "prajapatiaakash816@gmail.com";
  const nameAdmin = "Akash Prajapati";
  const phoneAdmin = "6377517817";
  const roleAdmin = "admin";

  const existAdmin = await prisma.admin.findUnique({
    where: { email: emailAdmin },
  });

  if (existAdmin) {
    console.log("Admin already exists");
    return;
  }

  const hashedPassword = await bcrypt.hash("akash1234", 10);

  await prisma.admin.create({
    data: {
=======
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
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
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
