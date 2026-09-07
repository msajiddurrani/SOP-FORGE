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
  const [errorToast, setErrorToast] = useState<string | null>(null);

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

      // Cancel any ongoing speech to avoid overlap
      if (window.speechSynthesis.speaking || window.speechSynthesis.pending) {
        window.speechSynthesis.cancel();
      }

      // Resume if stuck in paused state (known Chromium bug)
      if (window.speechSynthesis.paused) {
        window.speechSynthesis.resume();
      }

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.05;
      utterance.pitch = 1.0;

      // Detect if text contains Urdu script
      const hasUrduScript = /[\u0600-\u06FF]/.test(text);

      const voices = window.speechSynthesis.getVoices();
      let preferredVoice: SpeechSynthesisVoice | undefined;

      if (hasUrduScript) {
        preferredVoice = voices.find((v) => v.lang.startsWith("ur"));
      }

      if (!preferredVoice) {
        // Natural voice for English / Roman Urdu
        preferredVoice = voices.find(
          (v) =>
            (v.name.includes("Natural") ||
              v.name.includes("Google") ||
              v.name.includes("Jenny") ||
              v.name.includes("Aria") ||
              v.name.includes("Zira")) &&
            v.lang.startsWith("en")
        );
      }

      if (preferredVoice) {
        utterance.voice = preferredVoice;
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
        if (processingTimeoutRef.current) {
          clearTimeout(processingTimeoutRef.current);
          processingTimeoutRef.current = null;
        }
        setIsAiSpeaking(false);
        isAiSpeakingRef.current = false;
        setCallStatus("Call Active - Listening...");

        // Post-speech cooldown: wait 800ms before allowing VAD to capture again.
        setTimeout(() => {
          speechCooldownRef.current = false;
          console.log('[TTS] Speech cooldown lifted — VAD re-enabled');

          // Start / resume recorder after cooldown
          if (isCallingRef.current && mediaRecorder.current) {
            try {
              if (mediaRecorder.current.state === "inactive") {
                vadState.current.isSpeaking = false;
                vadState.current.silenceCount = 0;
                vadState.current.speechFrames = 0;
                vadState.current.idleFrames = 0;
                mediaRecorder.current.start();
                console.log('[MediaRecorder] Started (state was inactive)');
              } else if (mediaRecorder.current.state === "paused") {
                mediaRecorder.current.resume();
                console.log('[MediaRecorder] Resumed (state was paused)');
              }
            } catch (e) {
              console.error('[MediaRecorder] Failed to start/resume after cooldown:', e);
            }
          }
        }, 800);
      };

      utterance.onerror = (err: SpeechSynthesisErrorEvent) => {
        // 'canceled' or 'interrupted' are expected when user interrupts or call ends
        if (err.error === "canceled" || err.error === "interrupted") {
          return;
        }

        if (processingTimeoutRef.current) {
          clearTimeout(processingTimeoutRef.current);
          processingTimeoutRef.current = null;
        }
        console.warn('[TTS] SpeechSynthesis non-fatal notice:', err.error);
        setIsAiSpeaking(false);
        isAiSpeakingRef.current = false;
        speechCooldownRef.current = false;
        setCallStatus("Call Active - Listening...");

        // Resume recorder on TTS error
        if (isCallingRef.current && mediaRecorder.current) {
          try {
            if (mediaRecorder.current.state === "inactive") {
              vadState.current.isSpeaking = false;
              vadState.current.silenceCount = 0;
              vadState.current.speechFrames = 0;
              vadState.current.idleFrames = 0;
              mediaRecorder.current.start();
              console.log('[MediaRecorder] Started after TTS event');
            }
          } catch (e) {
            console.error('[MediaRecorder] Failed to start after TTS event:', e);
          }
        }
      };

      // Prevent garbage collection bug on Chrome/Safari which stops onend from firing
      (window as any).currentUtterance = utterance;

      // Small 50ms buffer prevents Chromium from dropping the new utterance right after cancel()
      setTimeout(() => {
        if (isCallingRef.current) {
          window.speechSynthesis.speak(utterance);
        }
      }, 50);
    },
    []
  );

  const vadState = useRef({
    isSpeaking: false,
    silenceCount: 0,
    speechFrames: 0,
    idleFrames: 0,
  });
  const isIdleReset = useRef(false);
  const processingTimeoutRef = useRef<NodeJS.Timeout | null>(null);

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
            vadState.current.speechFrames++;
            vadState.current.silenceCount = 0;
            vadState.current.idleFrames = 0;

            // Confirm speech after 2 consecutive frames to avoid clicks/pops
            if (vadState.current.speechFrames > 2) {
              vadState.current.isSpeaking = true;
            }

            // Max speech duration safety limit (~12 seconds = 720 frames)
            if (
              vadState.current.speechFrames > 720 &&
              mediaRecorder.current &&
              mediaRecorder.current.state === "recording"
            ) {
              vadState.current.isSpeaking = false;
              vadState.current.speechFrames = 0;
              mediaRecorder.current.stop();
              setCallStatus("Processing your request...");
            }
          } else {
            vadState.current.speechFrames = 0;

            if (vadState.current.isSpeaking) {
              vadState.current.silenceCount++;
              // ~500ms silence threshold (30 frames @ 60fps)
              if (vadState.current.silenceCount > 30) {
                vadState.current.isSpeaking = false;
                vadState.current.silenceCount = 0;
                vadState.current.idleFrames = 0;

                if (
                  mediaRecorder.current &&
                  mediaRecorder.current.state === "recording"
                ) {
                  mediaRecorder.current.stop();
                  setCallStatus("Processing your request...");

                  // Watchdog timer: if no AI response or status within 6 seconds, resume listening
                  if (processingTimeoutRef.current) clearTimeout(processingTimeoutRef.current);
                  processingTimeoutRef.current = setTimeout(() => {
                    if (
                      isCallingRef.current &&
                      !isAiSpeakingRef.current &&
                      mediaRecorder.current &&
                      mediaRecorder.current.state === "inactive"
                    ) {
                      try {
                        vadState.current.isSpeaking = false;
                        vadState.current.silenceCount = 0;
                        vadState.current.speechFrames = 0;
                        vadState.current.idleFrames = 0;
                        mediaRecorder.current.start();
                        setCallStatus("Call Active - Listening...");
                        console.log('[Watchdog] No response received in 6s, resumed listening');
                      } catch (e) {
                        console.error('[Watchdog] Failed to restart recorder:', e);
                      }
                    }
                  }, 6000);
                }
              }
            } else {
              // User is idle / silent
              vadState.current.idleFrames++;
              // Every ~4 seconds of silence (240 frames), recycle recorder to keep audio buffer small & fresh
              if (
                vadState.current.idleFrames > 240 &&
                mediaRecorder.current &&
                mediaRecorder.current.state === "recording"
              ) {
                vadState.current.idleFrames = 0;
                isIdleReset.current = true;
                mediaRecorder.current.stop();
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
        // Initialize MediaRecorder safely for cross-browser support (Safari does not support webm)
        const mimeOptions = "audio/webm;codecs=opus";
        if (MediaRecorder.isTypeSupported(mimeOptions)) {
          mediaRecorder.current = new MediaRecorder(streamRef.current!, {
            mimeType: mimeOptions,
          });
        } else {
          // Fallback to default browser codec (usually audio/mp4 on Safari)
          mediaRecorder.current = new MediaRecorder(streamRef.current!);
        }

        mediaRecorder.current.ondataavailable = (e) => {
          console.log(
            `[MediaRecorder] ondataavailable fired — size: ${e.data.size}B | wsState: ${ws.current?.readyState} | aiSpeaking: ${isAiSpeakingRef.current} | idleReset: ${isIdleReset.current}`
          );

          // If this was an idle buffer flush, discard silence and immediately restart fresh
          if (isIdleReset.current) {
            isIdleReset.current = false;
            if (
              isCallingRef.current &&
              !isAiSpeakingRef.current &&
              !speechCooldownRef.current &&
              mediaRecorder.current &&
              mediaRecorder.current.state === "inactive"
            ) {
              try {
                mediaRecorder.current.start();
              } catch (err) {
                console.error('[MediaRecorder] Failed to restart after idle reset:', err);
              }
            }
            return;
          }

          // If AI is speaking or speech cooldown, discard chunk
          if (isAiSpeakingRef.current || speechCooldownRef.current) {
            return;
          }

          // Complete speech audio blob with valid WebM container headers
          if (
            e.data.size > 1500 &&
            ws.current?.readyState === WebSocket.OPEN
          ) {
            e.data.arrayBuffer().then((buffer) => {
              console.log(`[WS] Sending complete standalone audio file: ${buffer.byteLength} bytes`);
              ws.current?.send(buffer);
            });
          } else {
            console.log('[MediaRecorder] Audio too small or empty, skipping send');
            // Resume listening if we skipped
            if (
              isCallingRef.current &&
              !isAiSpeakingRef.current &&
              mediaRecorder.current &&
              mediaRecorder.current.state === "inactive"
            ) {
              setTimeout(() => {
                try {
                  if (
                    isCallingRef.current &&
                    !isAiSpeakingRef.current &&
                    mediaRecorder.current?.state === "inactive"
                  ) {
                    mediaRecorder.current.start();
                    setCallStatus("Call Active - Listening...");
                  }
                } catch (err) {}
              }, 100);
            }
          }
        };

        // NOTE: Do NOT start MediaRecorder here.
        // It is started inside speakText.utterance.onend after the greeting finishes.
        console.log('[MediaRecorder] Initialized — waiting for greeting to finish before starting');
      };

      ws.current.onmessage = (event) => {
        if (typeof event.data === "string") {
          try {
            const data = JSON.parse(event.data);

            if (data.event === "transcription") {
              if (processingTimeoutRef.current) {
                clearTimeout(processingTimeoutRef.current);
                processingTimeoutRef.current = null;
              }
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
              if (processingTimeoutRef.current) {
                clearTimeout(processingTimeoutRef.current);
                processingTimeoutRef.current = null;
              }
              console.log('[WS] assistant_response received:', data.text?.substring(0, 60));
              // Speak the AI response via TTS
              if (data.text && data.text.trim()) {
                speakText(data.text);
              }
            } else if (data.event === "status") {
              if (data.status === "listening" && !isAiSpeakingRef.current) {
                if (processingTimeoutRef.current) {
                  clearTimeout(processingTimeoutRef.current);
                  processingTimeoutRef.current = null;
                }
                setCallStatus("Call Active - Listening...");
                if (
                  isCallingRef.current &&
                  mediaRecorder.current &&
                  mediaRecorder.current.state === "inactive"
                ) {
                  try {
                    vadState.current.isSpeaking = false;
                    vadState.current.silenceCount = 0;
                    vadState.current.speechFrames = 0;
                    vadState.current.idleFrames = 0;
                    mediaRecorder.current.start();
                    console.log('[MediaRecorder] Resumed on backend status event');
                  } catch (e) {}
                }
              }
            } else if (data.event === "error") {
              if (processingTimeoutRef.current) {
                clearTimeout(processingTimeoutRef.current);
                processingTimeoutRef.current = null;
              }
              console.error('[WS] Backend error event:', data.message);
              setErrorToast(data.message || 'An unknown backend error occurred.');
              setTimeout(() => setErrorToast(null), 6000);
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

    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }

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
      {/* ─── Background Layers ─── */}
      <div className={styles.auroraLayer}>
        <div className={styles.auroraBand1}></div>
        <div className={styles.auroraBand2}></div>
        <div className={styles.auroraBand3}></div>
        <div className={styles.auroraBand4}></div>
        <div className={styles.auroraBand5}></div>
      </div>

      <div className={styles.starField}></div>
      <div className={styles.gridOverlay}></div>
      <div className={styles.horizonGlow}></div>

      {/* ─── Error Toast ─── */}
      {errorToast && (
        <div className={styles.errorToast}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          {errorToast}
        </div>
      )}

      {/* ─── Main Command Panel ─── */}
      <main className={styles.voiceWidget} id="voice-widget">
        {/* Top Navbar */}
        <header className={styles.topNavbar}>
          <div className={styles.brandBadge}>
            <span className={styles.brandDot}></span>
            <div className={styles.brandInfo}>
              <span className={styles.brandTitle}>
                SOP Voice Triage Engine
              </span>
              <span className={styles.brandSubtitle}>Enterprise</span>
            </div>
          </div>
          {activeDepartment && (
            <div className={styles.routeBadge} id="route-badge">
              <svg
                width="13"
                height="13"
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

        {/* Call Status */}
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

        {/* Audio Visualizer — 32 bars */}
        <div className={styles.visualizerContainer}>
          {[...Array(32)].map((_, i) => (
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

        {/* Live Transcript Stream */}
        <div className={styles.transcriptSection}>
          <div className={styles.transcriptHeader}>
            <div className={styles.transcriptHeaderLeft}>
              {isCalling && <span className={styles.liveIndicator}></span>}
              <span>Live Voice Stream</span>
            </div>
            {isAiSpeaking && (
              <span className={styles.aiSpeakingTag}>
                <span className={styles.aiSpeakingTagDot}></span>
                AI Speaking
              </span>
            )}
          </div>
          <div className={styles.transcriptFeed} ref={transcriptContainerRef}>
            {transcripts.length === 0 ? (
              <div className={styles.emptyFeed}>
                <div className={styles.emptyFeedIcon}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(0,255,200,0.4)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                </div>
                <span className={styles.emptyFeedText}>
                  Tap the call button to start interactive voice triage with the AI assistant
                </span>
                <span className={styles.emptyFeedHint}>English & Urdu Supported</span>
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
                <div className={styles.auroraRing}></div>
                <div className={styles.auroraRing}></div>
                <div className={styles.auroraRing}></div>
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
                id="mute-btn"
                onClick={toggleMute}
                className={`${styles.utilityBtn} ${
                  isMuted ? styles.mutedBtn : ""
                }`}
                title={isMuted ? "Unmute Mic" : "Mute Mic"}
                aria-label={isMuted ? "Unmute microphone" : "Mute microphone"}
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
              id="call-btn"
              onClick={toggleCall}
              className={`${styles.voiceBtn} ${
                isCalling ? styles.endCallBtn : styles.startCallBtn
              }`}
              aria-label={isCalling ? "End call" : "Start call"}
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

