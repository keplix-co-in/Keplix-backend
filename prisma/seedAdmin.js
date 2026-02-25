import prisma from "../util/prisma.js";
import bcrypt from "bcryptjs";

const seedAdmin = async () => {
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
