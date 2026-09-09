"use client";

import { useState, useRef, useEffect } from "react";
import styles from "./page.module.css";
import gsap from "gsap";

export default function VoiceDashboard() {
  const [isRecording, setIsRecording] = useState(false);
  const [callStatus, setCallStatus] = useState("Connecting to server...");
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);

  const ws = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<BlobPart[]>([]);
  const visualizerBars = useRef<HTMLDivElement[]>([]);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  // Visualizer Animation Loop
  useEffect(() => {
    let animationFrame: number;
    const animate = () => {
      if (!isRecording && !isAiSpeaking) {
        gsap.to(visualizerBars.current, { height: 10, duration: 0.3 });
      } else {
        visualizerBars.current.forEach((bar, index) => {
          if (bar) {
            let height = 10;
            if (isAiSpeaking || isRecording) {
              height = Math.max(16, Math.sin(Date.now() / 120 + index * 0.8) * 50 + 52);
            }
            gsap.to(bar, { height, duration: 0.1, ease: "power1.out" });
          }
        });
      }
      animationFrame = requestAnimationFrame(animate);
    };
    animate();
    return () => cancelAnimationFrame(animationFrame);
  }, [isRecording, isAiSpeaking]);

  useEffect(() => {
    // Setup WebSocket
    const wsUrl = process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000/ws/voice";
    ws.current = new WebSocket(wsUrl);
    ws.current.binaryType = "blob";

    ws.current.onopen = () => {
      setCallStatus("Ready - Press to Speak");
    };

    ws.current.onmessage = async (event) => {
      if (event.data instanceof Blob) {
        // Play received audio
        setIsAiSpeaking(true);
        setCallStatus("AI is Speaking...");
        const audioUrl = URL.createObjectURL(event.data);
        if (audioPlayerRef.current) {
          audioPlayerRef.current.pause();
        }
        const audio = new Audio(audioUrl);
        audioPlayerRef.current = audio;
        
        audio.onended = () => {
          setIsAiSpeaking(false);
          setCallStatus("Ready - Press to Speak");
        };
        
        audio.play().catch(e => {
          console.error("Error playing audio", e);
          setIsAiSpeaking(false);
          setCallStatus("Ready - Press to Speak");
        });
      } else if (typeof event.data === "string") {
        try {
          const data = JSON.parse(event.data);
          if (data.event === "error") {
            setErrorToast(data.message);
            setCallStatus("Ready - Press to Speak");
          } else if (data.event === "department_transfer") {
            setCallStatus(`Transferring to: ${data.target}`);
          } else if (data.event === "processing") {
            setCallStatus("Processing...");
          }
        } catch(e) {}
      }
    };

    ws.current.onerror = () => {
      setCallStatus("Voice Gateway Error");
    };

    return () => {
      if (ws.current) ws.current.close();
    };
  }, []);

  const startRecording = async () => {
    if (isAiSpeaking && audioPlayerRef.current) {
        audioPlayerRef.current.pause();
        setIsAiSpeaking(false);
    }
    
    setErrorToast(null);
    try {
      if (!streamRef.current) {
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      
      const options = { mimeType: 'audio/webm' };
      const mediaRecorder = new MediaRecorder(streamRef.current, options);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(audioBlob);
          setCallStatus("Sending...");
        }
      };

      mediaRecorder.start();
      setIsRecording(true);
      setCallStatus("Recording...");
    } catch (err) {
      console.error("Error accessing microphone:", err);
      setErrorToast("Microphone Permission Denied");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setCallStatus("Processing...");
    }
  };

  const toggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <div className={styles.appContainer}>
      <div className={styles.auroraLayer}>
        <div className={styles.auroraBand1}></div>
        <div className={styles.auroraBand2}></div>
        <div className={styles.auroraBand3}></div>
      </div>
      <div className={styles.starField}></div>
      <div className={styles.gridOverlay}></div>

      {errorToast && (
        <div className={styles.errorToast}>
          {errorToast}
        </div>
      )}

      <main className={styles.voiceWidget}>
        <header className={styles.topNavbar}>
          <div className={styles.brandBadge}>
            <span className={styles.brandDot}></span>
            <div className={styles.brandInfo}>
              <span className={styles.brandTitle}>SOP Voice Triage Engine</span>
              <span className={styles.brandSubtitle}>Powered by Groq + ElevenLabs</span>
            </div>
          </div>
        </header>

        <div className={styles.callHeader}>
          <div className={styles.statusBadge}>
            <span className={`${styles.statusDot} ${(isRecording || isAiSpeaking) ? styles.activeDot : styles.idleDot}`}></span>
            <span className={styles.statusText}>{callStatus}</span>
          </div>
        </div>

        <div className={styles.visualizerContainer}>
          {[...Array(32)].map((_, i) => (
            <div key={i} className={`${styles.visualizerBar} ${(isAiSpeaking || isRecording) ? styles.barSpeaking : ""}`} ref={(el) => { if (el) visualizerBars.current[i] = el; }} />
          ))}
        </div>

        <div className={styles.controlCenter}>
          <div className={styles.buttonRow}>
            <button 
              onClick={toggleRecording}
              className={`${styles.voiceBtn} ${isRecording ? styles.endCallBtn : styles.startCallBtn}`}
              style={{ cursor: "pointer" }}
            >
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={styles.btnIcon}>
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                <line x1="12" y1="19" x2="12" y2="23"></line>
                <line x1="8" y1="23" x2="16" y2="23"></line>
              </svg>
            </button>
          </div>
          <div style={{color: 'rgba(255,255,255,0.5)', marginTop: '1rem', fontSize: '14px', fontWeight: 'bold'}}>
            {isRecording ? "Click to Send" : "Click to Speak"}
          </div>
        </div>
      </main>
    </div>
  );
}
