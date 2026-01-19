# Deployment Guide - Google Cloud Platform

## Prerequisites

1. **Google Cloud Account** with billing enabled
2. **GitHub Repository** with your backend code
3. **Google Cloud Project** created

## Setup Instructions

### 1. Enable Required APIs

```bash
gcloud services enable run.googleapis.com
gcloud services enable containerregistry.googleapis.com
gcloud services enable secretmanager.googleapis.com
```

### 2. Create Service Account

```bash
# Create service account
gcloud iam service-accounts create github-actions \
    --display-name "GitHub Actions Deployment"

# Get your project ID
export PROJECT_ID=$(gcloud config get-value project)

# Grant necessary permissions
gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-actions@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/run.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-actions@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/storage.admin"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-actions@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/iam.serviceAccountUser"

gcloud projects add-iam-policy-binding $PROJECT_ID \
    --member="serviceAccount:github-actions@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"

# Create and download service account key
gcloud iam service-accounts keys create key.json \
    --iam-account=github-actions@$PROJECT_ID.iam.gserviceaccount.com
```

### 3. Store Secrets in Google Cloud Secret Manager

```bash
# Create secrets
echo -n "your-database-url" | gcloud secrets create DATABASE_URL --data-file=-
echo -n "your-jwt-secret" | gcloud secrets create JWT_SECRET --data-file=-
echo -n "your-razorpay-key-id" | gcloud secrets create RAZORPAY_KEY_ID --data-file=-
echo -n "your-razorpay-key-secret" | gcloud secrets create RAZORPAY_KEY_SECRET --data-file=-

# Grant access to Cloud Run service account
gcloud secrets add-iam-policy-binding DATABASE_URL \
    --member="serviceAccount:github-actions@$PROJECT_ID.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
```

### 4. Configure GitHub Secrets

Go to your GitHub repository → Settings → Secrets and variables → Actions

Add the following secrets:

- **GCP_PROJECT_ID**: Your Google Cloud Project ID
- **GCP_SA_KEY**: Contents of the `key.json` file created above

### 5. Update Configuration

Edit `.github/workflows/deploy.yml` and update:
- `REGION`: Your preferred GCP region (e.g., `us-central1`, `asia-south1`)
- Branch names in the `on.push.branches` section
- Resource limits (memory, CPU) based on your needs

## Local Docker Testing

### Build and run locally:

```bash
# Build the image
docker build -t keplix-backend .

# Run with environment variables
docker run -p 8000:8000 \
  -e DATABASE_URL="your-db-url" \
  -e JWT_SECRET="your-secret" \
  keplix-backend
```

### Or use docker-compose:

```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f

# Stop services
docker-compose down
```

## Manual Deployment to Cloud Run

```bash
# Build and push to Google Container Registry
gcloud builds submit --tag gcr.io/$PROJECT_ID/keplix-backend

# Deploy to Cloud Run
gcloud run deploy keplix-backend \
  --image gcr.io/$PROJECT_ID/keplix-backend \
  --platform managed \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest,JWT_SECRET=JWT_SECRET:latest"
```

## Post-Deployment

### Run Database Migrations

After deploying, you may need to run Prisma migrations:

```bash
# Connect to Cloud Run service
gcloud run services describe keplix-backend --region asia-south1

# Or run migrations as a one-off job
gcloud run jobs create migrate-db \
  --image gcr.io/$PROJECT_ID/keplix-backend \
  --command npx \
  --args prisma,migrate,deploy \
  --set-secrets="DATABASE_URL=DATABASE_URL:latest" \
  --region asia-south1

gcloud run jobs execute migrate-db --region asia-south1
```

### Monitor Logs

```bash
# View logs
gcloud run services logs read keplix-backend --region asia-south1

# Or use Cloud Console
https://console.cloud.google.com/run
```

## Troubleshooting

### Common Issues

1. **Port Configuration**: Ensure your server listens on `process.env.PORT || 8000`
2. **Database Connection**: Verify DATABASE_URL is correctly set in Secret Manager
3. **Build Failures**: Check Docker build logs in GitHub Actions
4. **Memory Issues**: Increase memory limit in deploy.yml

### Health Check

Add to your `server.js`:

```javascript
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});
```

## Cost Optimization

- Set `--min-instances 0` to scale to zero when not in use
- Use `--max-instances` to control costs
- Monitor usage in GCP Console

## Security Best Practices

1. Never commit `.env` files or secrets
2. Use Secret Manager for sensitive data
3. Regularly rotate service account keys
4. Enable VPC connector for private database access
5. Set up Cloud Armor for DDoS protection
