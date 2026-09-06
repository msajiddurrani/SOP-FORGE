"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import styles from "./page.module.css";
import gsap from "gsap";

interface TranscriptItem {
  id: string;
  sender: "AI" | "User" | "System";
  text: string;
  timestamp: string;
  isTransfer?: boolean;
}

export default function VoiceDashboard() {
  const [isCalling, setIsCalling] = useState(false);
  const [callDuration, setCallDuration] = useState(0);
  const [callStatus, setCallStatus] = useState("Ready to Connect");
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [activeDepartment, setActiveDepartment] = useState<string | null>(null);

  const ws = useRef<WebSocket | null>(null);
  const mediaRecorder = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const analyserNode = useRef<AnalyserNode | null>(null);
  const visualizerBars = useRef<HTMLDivElement[]>([]);
  const transcriptContainerRef = useRef<HTMLDivElement | null>(null);

  // Refs to track state inside animation loops / event handlers without closure lag
  const isAiSpeakingRef = useRef(false);
  const isMutedRef = useRef(false);
  const isCallingRef = useRef(false);

  // Cooldown timer ref — blocks VAD for N ms after AI finishes speaking
  // to prevent echo/feedback from being transcribed
  const speechCooldownRef = useRef(false);

  useEffect(() => {
    isAiSpeakingRef.current = isAiSpeaking;
  }, [isAiSpeaking]);

  useEffect(() => {
    isMutedRef.current = isMuted;
  }, [isMuted]);

  useEffect(() => {
    isCallingRef.current = isCalling;
  }, [isCalling]);

  // Call duration timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (isCalling) {
      interval = setInterval(() => {
        setCallDuration((prev) => prev + 1);
      }, 1000);
    } else {
      setCallDuration(0);
    }
    return () => clearInterval(interval);
  }, [isCalling]);

  // Auto-scroll transcript container
  useEffect(() => {
    if (transcriptContainerRef.current) {
      transcriptContainerRef.current.scrollTop =
        transcriptContainerRef.current.scrollHeight;
    }
  }, [transcripts]);

  const formatTime = (seconds: number) => {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hrs > 0)
      return `${hrs.toString().padStart(2, "0")}:${mins
        .toString()
        .padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
    return `${mins.toString().padStart(2, "0")}:${secs
      .toString()
      .padStart(2, "0")}`;
  };

  const getTimeString = () => {
    return new Date().toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  };

  // ─── Speech Synthesis (Browser TTS) ─────────────────────────────
  const speakText = useCallback(
    (text: string) => {
      if (!("speechSynthesis" in window)) return;

      window.speechSynthesis.cancel(); // Stop any pending speech

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;

      // Pick best natural voice available on browser
      const voices = window.speechSynthesis.getVoices();
      const naturalVoice = voices.find(
        (v) =>
          (v.name.includes("Natural") ||
            v.name.includes("Google") ||
            v.name.includes("Jenny") ||
            v.name.includes("Aria") ||
            v.name.includes("Zira")) &&
          v.lang.startsWith("en")
      );
      if (naturalVoice) {
        utterance.voice = naturalVoice;
      }

      utterance.onstart = () => {
        setIsAiSpeaking(true);
        isAiSpeakingRef.current = true;
        speechCooldownRef.current = true; // Block VAD during speech
        setCallStatus("AI Assistant Speaking...");

        // Pause recorder while AI speaks to prevent echo capture
        if (
          mediaRecorder.current &&
          mediaRecorder.current.state === "recording"
        ) {
          try {
            mediaRecorder.current.stop();
          } catch (e) {}
        }
      };

      utterance.onend = () => {
        setIsAiSpeaking(false);
        isAiSpeakingRef.current = false;
        setCallStatus("Call Active - Listening...");

        // Post-speech cooldown: wait 800ms before allowing VAD to capture again.
        // This prevents the tail end of TTS audio bleeding into the microphone
        // and being transcribed by Whisper as a hallucination.
        setTimeout(() => {
          speechCooldownRef.current = false;

          // Resume recorder after cooldown
          if (
            isCallingRef.current &&
            mediaRecorder.current &&
            mediaRecorder.current.state === "inactive"
          ) {
            try {
              mediaRecorder.current.start();
            } catch (e) {}
          }
        }, 800);
      };

      // Prevent garbage collection bug on Chrome/Safari which stops onend from firing
      (window as any).currentUtterance = utterance;
      window.speechSynthesis.speak(utterance);

      utterance.onerror = () => {
        setIsAiSpeaking(false);
        isAiSpeakingRef.current = false;
        speechCooldownRef.current = false;
        setCallStatus("Call Active - Listening...");

        // Resume recorder on error too
        if (
          isCallingRef.current &&
          mediaRecorder.current &&
          mediaRecorder.current.state === "inactive"
        ) {
          try {
            mediaRecorder.current.start();
          } catch (e) {}
        }
      };

      window.speechSynthesis.speak(utterance);
    },
    []
  );

  const vadState = useRef({ isSpeaking: false, silenceCount: 0 });

  // ─── GSAP Visualizer & High-Speed VAD Loop ─────────────────────
  useEffect(() => {
    if (!isCalling) {
      gsap.to(visualizerBars.current, { height: 10, duration: 0.3 });
      return;
    }

    let animationFrame: number;
    const animate = () => {
      if (analyserNode.current) {
        const dataArray = new Uint8Array(
          analyserNode.current.frequencyBinCount
        );
        analyserNode.current.getByteFrequencyData(dataArray);

        let sum = 0;
        visualizerBars.current.forEach((bar, index) => {
          if (bar) {
            let height = 10;
            if (isAiSpeakingRef.current) {
              // Smooth dynamic wave animation when AI is speaking
              height = Math.max(
                16,
                Math.sin(Date.now() / 120 + index * 0.8) * 50 + 52
              );
            } else {
              const value = dataArray[index * 2] || 0;
              sum += value;
              height = Math.max(10, (value / 255) * 120);
            }
            gsap.to(bar, { height, duration: 0.08, ease: "power1.out" });
          }
        });

        // VAD: Only when AI is quiet, mic is unmuted, AND cooldown has passed
        if (
          !isAiSpeakingRef.current &&
          !isMutedRef.current &&
          !speechCooldownRef.current
        ) {
          const avg = sum / (visualizerBars.current.length || 1);
          if (avg > 14) {
            vadState.current.isSpeaking = true;
            vadState.current.silenceCount = 0;
          } else {
            if (vadState.current.isSpeaking) {
              vadState.current.silenceCount++;
              // ~400ms silence threshold (24 frames @ 60fps)
              if (vadState.current.silenceCount > 24) {
                vadState.current.isSpeaking = false;
                vadState.current.silenceCount = 0;
                if (
                  mediaRecorder.current &&
                  mediaRecorder.current.state === "recording"
                ) {
                  mediaRecorder.current.stop();
                  mediaRecorder.current.start();
                  setCallStatus("Processing your request...");
                }
              }
            }
          }
        }
      }
      animationFrame = requestAnimationFrame(animate);
    };
    animate();

    return () => cancelAnimationFrame(animationFrame);
  }, [isCalling]);

  const toggleCall = () => {
    if (isCalling) {
      endCall();
    } else {
      startCall();
    }
  };

  const toggleMute = () => {
    if (streamRef.current) {
      const audioTracks = streamRef.current.getAudioTracks();
      audioTracks.forEach((track) => {
        track.enabled = !track.enabled;
      });
      setIsMuted(!isMuted);
    }
  };

  // ─── Start Call ─────────────────────────────────────────────────
  const startCall = async () => {
    setIsCalling(true);
    isCallingRef.current = true;
    setActiveDepartment(null);
    setTranscripts([]);
    setCallStatus("Connecting...");

    try {
      // 1. Microphone setup with echo cancellation
      streamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      audioContext.current = new (window.AudioContext ||
        (window as any).webkitAudioContext)();
      const source = audioContext.current.createMediaStreamSource(
        streamRef.current
      );
      analyserNode.current = audioContext.current.createAnalyser();
      analyserNode.current.fftSize = 64;
      source.connect(analyserNode.current);

      // 2. Play the greeting ONCE — frontend owns this, backend does NOT send one
      const greetingMsg = "Hello sir, how can I help you?";
      setTranscripts([
        {
          id: "initial-greeting",
          sender: "AI",
          text: greetingMsg,
          timestamp: getTimeString(),
        },
      ]);

      setIsAiSpeaking(true);
      isAiSpeakingRef.current = true;
      speechCooldownRef.current = true;
      setCallStatus("AI Assistant Speaking...");

      // Use browser speech synthesis for greeting (works reliably without an mp3 file)
      speakText(greetingMsg);

      // 3. Connect WebSocket to backend
      const wsUrl =
        process.env.NEXT_PUBLIC_WS_URL || "ws://localhost:8000/ws/voice";
      ws.current = new WebSocket(wsUrl);
      ws.current.binaryType = "arraybuffer";

      ws.current.onopen = () => {
        // Initialize MediaRecorder — but DON'T start it yet.
        // It starts automatically after AI greeting finishes speaking (via utterance.onend).
        mediaRecorder.current = new MediaRecorder(streamRef.current!, {
          mimeType: "audio/webm;codecs=opus",
        });

        mediaRecorder.current.ondataavailable = (e) => {
          if (
            e.data.size > 0 &&
            ws.current?.readyState === WebSocket.OPEN &&
            !isAiSpeakingRef.current &&
            !speechCooldownRef.current
          ) {
            e.data.arrayBuffer().then((buffer) => {
              ws.current?.send(buffer);
            });
          }
        };
      };

      ws.current.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);

            if (data.event === "transcription") {
              const text: string = data.text;
              let sender: "AI" | "User" | "System" = "AI";
              let content = text;

              if (text.startsWith("You: ")) {
                sender = "User";
                content = text.replace("You: ", "");
              } else if (text.startsWith("AI: ")) {
                sender = "AI";
                content = text.replace("AI: ", "");
              }

              // Deduplicate: don't add if the last message from the same sender has the same text
              setTranscripts((prev) => {
                const lastSameSender = [...prev]
                  .reverse()
                  .find((t) => t.sender === sender);
                if (
                  lastSameSender &&
                  lastSameSender.text.trim().toLowerCase() ===
                    content.trim().toLowerCase()
                ) {
                  return prev; // Skip duplicate
                }
                return [
                  ...prev,
                  {
                    id: Math.random().toString(36).substr(2, 9),
                    sender,
                    text: content,
                    timestamp: getTimeString(),
                  },
                ];
              });
            } else if (data.event === "assistant_response") {
              // Speak the AI response via TTS
              if (data.text && data.text.trim()) {
                speakText(data.text);
              }
            } else if (data.event === "department_transfer") {
              const targetDept = data.target;
              setActiveDepartment(targetDept);
              setCallStatus(
                `Call Connected to ${targetDept.replace(/_/g, " ")}`
              );

              setTranscripts((prev) => [
                ...prev,
                {
                  id: Math.random().toString(36).substr(2, 9),
                  sender: "System",
                  text: `⚡ CALL ROUTED TO: ${targetDept
                    .replace(/_/g, " ")
                    .toUpperCase()} DESK`,
                  timestamp: getTimeString(),
                  isTransfer: true,
                },
              ]);
            }
          } catch (e) {
            console.error("JSON parse error", e);
          }
        }
      };

      ws.current.onerror = () => {
        setCallStatus("Voice Gateway Reconnecting...");
      };

      ws.current.onclose = () => {
        if (isCallingRef.current) {
          setCallStatus("Call Disconnected");
          endCall();
        }
      };
    } catch (e) {
      console.error(e);
      setCallStatus("Microphone Permission Denied");
      setTimeout(() => {
        setIsCalling(false);
        isCallingRef.current = false;
      }, 2500);
    }
  };

  // ─── End Call ─────────────────────────────────────────────────
  const endCall = () => {
    setIsCalling(false);
    isCallingRef.current = false;
    setIsAiSpeaking(false);
    isAiSpeakingRef.current = false;
    speechCooldownRef.current = false;
    setIsMuted(false);
    isMutedRef.current = false;
    setCallStatus("Call Ended");

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
    if (ws.current) {
      ws.current.close();
      ws.current = null;
    }
    if (mediaRecorder.current) {
      try {
        if (mediaRecorder.current.state !== "inactive") {
          mediaRecorder.current.stop();
        }
      } catch (e) {}
      mediaRecorder.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (audioContext.current) {
      audioContext.current.close();
      audioContext.current = null;
    }
  };

  return (
    <div className={styles.appContainer}>
      {/* Background Animated Aurora */}
      <div className={styles.auroraLayer}>
        <div className={styles.auroraBand1}></div>
        <div className={styles.auroraBand2}></div>
        <div className={styles.auroraBand3}></div>
      </div>

      <div className={styles.gridOverlay}></div>

      <main className={styles.voiceWidget}>
        {/* Top Navigation / Brand */}
        <header className={styles.topNavbar}>
          <div className={styles.brandBadge}>
            <span className={styles.brandDot}></span>
            <span className={styles.brandTitle}>
              SOP Voice Triage Engine v2.0
            </span>
          </div>
          {activeDepartment && (
            <div className={styles.routeBadge}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
              >
                <path d="M16 3h5v5M4 20L21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
              </svg>
              <span>{activeDepartment.replace(/_/g, " ")}</span>
            </div>
          )}
        </header>

        {/* Call Status Header */}
        <div className={styles.callHeader}>
          <div className={styles.statusBadge}>
            <span
              className={`${styles.statusDot} ${
                isCalling
                  ? isAiSpeaking
                    ? styles.speakingDot
                    : styles.activeDot
                  : styles.idleDot
              }`}
            ></span>
            <span className={styles.statusText}>{callStatus}</span>
          </div>
          {isCalling && (
            <div className={styles.durationTimer}>
              {formatTime(callDuration)}
            </div>
          )}
        </div>

        {/* Central Siri Wave / Audio Visualizer */}
        <div className={styles.visualizerContainer}>
          {[...Array(24)].map((_, i) => (
            <div
              key={i}
              className={`${styles.visualizerBar} ${
                isAiSpeaking ? styles.barSpeaking : ""
              }`}
              ref={(el) => {
                if (el) visualizerBars.current[i] = el;
              }}
            />
          ))}
        </div>

        {/* Live Audio Transcript Stream */}
        <div className={styles.transcriptSection}>
          <div className={styles.transcriptHeader}>
            <span>Live Voice Audio Stream</span>
            {isAiSpeaking && (
              <span className={styles.aiSpeakingTag}>AI Speaking</span>
            )}
          </div>
          <div className={styles.transcriptFeed} ref={transcriptContainerRef}>
            {transcripts.length === 0 ? (
              <div className={styles.emptyFeed}>
                Tap the Call Button to start interactive voice triage with AI...
              </div>
            ) : (
              transcripts.map((item) => (
                <div
                  key={item.id}
                  className={`${styles.transcriptBubble} ${
                    item.sender === "User"
                      ? styles.userBubble
                      : item.sender === "System"
                      ? styles.systemBubble
                      : styles.aiBubble
                  }`}
                >
                  <div className={styles.bubbleHeader}>
                    <span className={styles.speakerName}>{item.sender}</span>
                    <span className={styles.bubbleTime}>{item.timestamp}</span>
                  </div>
                  <div className={styles.bubbleContent}>{item.text}</div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Control Center */}
        <div className={styles.controlCenter}>
          <div className={styles.siriGlowContainer}>
            {isCalling && (
              <>
                <div className={styles.organicGlow}></div>
                <div
                  className={`${styles.siriGlow} ${
                    isAiSpeaking ? styles.siriGlowSpeaking : ""
                  }`}
                ></div>
              </>
            )}
          </div>

          <div className={styles.buttonRow}>
            {isCalling && (
              <button
                onClick={toggleMute}
                className={`${styles.utilityBtn} ${
                  isMuted ? styles.mutedBtn : ""
                }`}
                title={isMuted ? "Unmute Mic" : "Mute Mic"}
              >
                <svg
                  width="22"
                  height="22"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  {isMuted ? (
                    <>
                      <line x1="1" y1="1" x2="23" y2="23" />
                      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </>
                  ) : (
                    <>
                      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                      <line x1="12" y1="19" x2="12" y2="23" />
                      <line x1="8" y1="23" x2="16" y2="23" />
                    </>
                  )}
                </svg>
              </button>
            )}

            <button
              onClick={toggleCall}
              className={`${styles.voiceBtn} ${
                isCalling ? styles.endCallBtn : styles.startCallBtn
              }`}
            >
              <div className={styles.btnInnerGlow}></div>
              <svg
                width="32"
                height="32"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={styles.btnIcon}
              >
                {isCalling ? (
                  <>
                    <path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91" />
                    <line x1="22" y1="2" x2="2" y2="22" />
                  </>
                ) : (
                  <>
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path>
                  </>
                )}
              </svg>
            </button>
          </div>
        </div>
      </main>
    </div>
  );
}
