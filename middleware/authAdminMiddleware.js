import jwt from "jsonwebtoken";

const authAdmin = (req, res, next) => {
  const authHeader = req.header.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Token Missing" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } 
  catch (error) {
    return res.status(401).json({ message: "Invalid oe expired token" });
  }
};

const allowedRoles = ["admin"];

const authorizeAdmin = (req, res, next) => {
  if(! req.user || !allowedRoles.includes(req.user.role)){
    return res.status(403).json({message: "Access Denied"});
  }
  next();

}

export  default {authAdmin, authorizeAdmin};