# SOP Forge Voice Triage Engine

An AI-powered voice triage system that handles live employee phone calls, uses speech-to-text, evaluates intent, and seamlessly routes calls to internal enterprise departments (IT Support, Finance, HR) based on predefined rules.

## Project Structure

The project is split into two independent services:

- `/frontend` - A Next.js (React) application for the voice dashboard and WebSocket audio streaming.
- `/backend` - A FastAPI (Python) backend integrating Groq LLM and ElevenLabs TTS for conversational intent routing.
- `/supabase` - Database schemas for logging and tracking.

## 🚀 Deployment Guide

This project requires **two** separate deployments because the backend relies on persistent WebSockets, which Vercel Serverless Functions do not support.

### 1. Backend Deployment (Render or Railway)

The backend must be deployed to a service that supports long-running processes and WebSockets (like Render.com, Railway.app, or a standard VPS).

1. Connect your GitHub repository to Render or Railway.
2. Set the Root Directory to `backend` (or create a separate service pointing to the backend folder).
3. Set the Start Command to: `uvicorn main:app --host 0.0.0.0 --port $PORT`
4. Add your Environment Variables:
   - `GROQ_API_KEY`
   - `ELEVENLABS_API_KEY`
   - `ELEVENLABS_VOICE_ID`
5. Deploy and copy your new backend URL (e.g., `https://your-backend-app.onrender.com`).

### 2. Frontend Deployment (Vercel)

The frontend is fully optimized for Vercel.

1. Go to your [Vercel Dashboard](https://vercel.com/dashboard) and click **Add New > Project**.
2. Import this GitHub repository.
3. **CRITICAL**: In the "Framework Preset" section, ensure it detects **Next.js**.
4. **CRITICAL**: In the "Root Directory" section, click Edit and select `frontend`.
5. Under **Environment Variables**, add:
   - Name: `NEXT_PUBLIC_WS_URL`
   - Value: `wss://your-backend-app.onrender.com/ws/voice` (Replace with your actual backend URL, making sure to use `wss://` instead of `https://`).
6. Click **Deploy**.

## 💻 Local Development

### Backend
```bash
cd backend
python -m venv venv
source venv/bin/activate  # Or venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Visit `http://localhost:3000` to access the dashboard.
