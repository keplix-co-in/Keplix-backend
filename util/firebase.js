import admin from 'firebase-admin';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Logger from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const require = createRequire(import.meta.url);

let messaging = null;

try {
    // Check if running in Cloud Run with base64 encoded credentials
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
        const serviceAccount = JSON.parse(
            Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf-8')
        );
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            messaging = admin.messaging();
            Logger.info('Firebase Admin Initialized (from env variable)');
        }
    } 
    // Fallback to local file
    else if (fs.existsSync(path.join(__dirname, '../serviceAccountKey.json'))) {
        const serviceAccount = require('../serviceAccountKey.json');
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            messaging = admin.messaging();
            Logger.info('Firebase Admin Initialized (from local file)');
        }
    } else {
        Logger.warn('Firebase not configured - Push notifications disabled');
    }
} catch (error) {
    Logger.error('Firebase Initialization Failed:', error.message);
    Logger.warn('Continuing without Firebase - Push notifications disabled');
}

// Export safe messaging object
export { messaging };
export default admin;
