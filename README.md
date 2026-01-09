# Keplix Backend (Node.js)

This is the backend server for Keplix, built with Node.js, Express, and Prisma. It handles authentication, service management, bookings, interactions, and more for both Users and Vendors.

## Features

- **Authentication**: User and Vendor authentication using JWT and Firebase.
- **Role-Based Access**: Distinct routes and logic for Users and Vendors.
- **Service Management**: CRUD operations for services offered by vendors.
- **Booking System**: Comprehensive booking flow (create, update, cancel).
- **Inventory & Availability**: Manage stock and time slots.
- **Real-time**: Socket.io integration for real-time features.
- **File Uploads**: Media handling using Multer.
- **Database**: ORM using Prisma (SQLite for development).

## Tech Stack

- **Runtime**: Node.js
- **Framework**: Express.js
- **Database**: SQLite (via Prisma ORM)
- **Authentication**: JWT, Firebase Admin
- **Real-time**: Socket.io
- **File Handling**: Multer

## Prerequisites

- Node.js (v16 or higher recommended)
- npm or yarn

## Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/Ashu19025/Keplix-backend.git
    cd Keplix-backend
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Setup Environment Variables:**
    Create a `.env` file in the root directory. You can use the example below as a template:

    ```env
    PORT=5000
    DATABASE_URL="file:./dev.db"
    JWT_SECRET="your_super_secret_key"
    # Add other necessary variables (e.g., Firebase config)
    ```

4.  **Setup Service Account:**
    Place your Google Cloud/Firebase service account JSON file in the root directory and name it `serviceAccountKey.json`.
    *Note: This file is git-ignored for security.*

5.  **Initialize Database:**
    ```bash
    npm run prisma:generate
    npm run prisma:push
    ```

## Scripts

-   `npm run dev`: Starts the server in development mode with Nodemon.
-   `npm start`: Starts the server in production mode.
-   `npm run prisma:studio`: Opens Prisma Studio to view and edit database records.
-   `npm run prisma:generate`: Generates the Prisma Client.
-   `npm run prisma:push`: Pushes the schema state to the database.

## Project Structure

```
keplix-backend/
├── controllers/        # Request handlers (Business Logic)
│   ├── user/           # User-specific controllers
│   ├── vendor/         # Vendor-specific controllers
│   └── ...             # Shared controllers
├── middleware/         # Express middleware (Auth, Uploads)
├── prisma/             # Database schema and SQLite file
├── routes/             # API Route definitions
│   ├── user/           # User-specific routes
│   ├── vendor/         # Vendor-specific routes
│   └── ...             # Shared routes
├── media/              # Uploaded static files
├── server.js           # Entry point
└── ...
```

## API Endpoints Overview

The API is organized into several sections:

-   **Auth**: `/api/auth`
-   **User**:
    -   Services: `/api/user/services`
    -   Bookings: `/api/user/bookings`
    -   Reviews: `/api/reviews`
    -   Feedback: `/api/feedback`
-   **Vendor**:
    -   Services: `/api/vendor/services`
    -   Bookings: `/api/vendor/bookings`
    -   Inventory: `/api/inventory`
    -   Availability: `/api/availability`
    -   Documents: `/api/documents`
    -   Promotions: `/api/promotions`
-   **Shared**:
    -   Interactions: `/api/interactions`
    -   Notifications: `/api/notifications`
    -   Payments: `/api/payments`

*(Note: Check `server.js` and route files for the exact path configurations)*
