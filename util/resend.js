import { Resend } from 'resend';

// Only instantiate if API key is configured
export const resend = process.env.RESEND_API_KEY 
  ? new Resend(process.env.RESEND_API_KEY)
  : null;