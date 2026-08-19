<<<<<<< HEAD
export const generateOTP = ()=>{
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit OTP
=======
import crypto from 'crypto';

export const generateOTP = ()=>{
  return crypto.randomInt(100000, 1000000).toString(); // 6-digit OTP
>>>>>>> eaee52b12e147de79c7937b99b425177c5de381d
}