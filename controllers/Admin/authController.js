import prisma from '../../util/prisma.js';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
const JWT_SECRET = process.env.JWT_SECRET;

const generateToken = (id) => {
  return jwt.sign({ id }, JWT_SECRET, {
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

    if (user.password !== password) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const userData = {
      id: user.id,
      email: user.email,
      name: user.name,
    };

    res.json({
      user: userData,
      token: generateToken(user.id),
      refresh: generateToken(user.id),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server error" });
  }
};


export const resetPassword = async (req,res) => {
  const {token} = req.params;
  const {password, re_password} = req.body;

  if( password !== re_password){
    return res.status(400).json({message: "Passwords do not match"});
  }

  const hashedToken = crypto.createHash("sha256").update(token).digest("hex");

  const admin = await prisma.admin.findFirst({
      where: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: {
          gt: new Date(),
        },
      },
    });

    if(!admin){
      return res
      .status(400)
      .json({messages: "Invalid or expired token"});
    }

    const hashedPassword = await bcrypt.hash(password,10);

    await prisma.admin.update({
      where: {id: admin.id},
      data: {
        password: hashedPassword,
        resetPasswordToken: null,
        resetPasswordExpires: null,
      },
    });

    res.json({message: "Password reset successful"});

}