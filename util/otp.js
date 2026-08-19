import crypto from 'crypto';

export const generateOTP = ()=>{
  return crypto.randomInt(100000, 1000000).toString(); // 6-digit OTP
}