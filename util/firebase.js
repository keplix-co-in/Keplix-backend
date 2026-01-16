import admin from 'firebase-admin';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

try {
    const serviceAccount = require('../serviceAccountKey.json');
    if (!admin.apps.length) {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin Initialized");
    }
} catch (error) {
    console.error("Firebase Initialization Failed (Check serviceAccountKey.json):", error.message);
}

export const messaging = admin.messaging();
export default admin;
