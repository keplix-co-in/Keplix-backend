import prisma from '../../util/prisma.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
const JWT_SECRET = process.env.JWT_SECRET;

const generateToken = (user) => {
  return jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: "30d",
  });
};

export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const user = await prisma.admin.findUnique({ where: { email } });

    if (!user) {
      return (res.status(404), json({ message: "Admin not found" }));
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if(!isPasswordValid){
      return res.status(401).json({ message: "Invalid password" });
    };

    const userData = {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role
    };

    res.json({
      user: userData,
      token: generateToken(user),
      refresh: generateToken(user),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};


