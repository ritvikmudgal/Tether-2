import { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useGuardians } from '../contexts/GuardianContext';
import { triggerEmergencyAlert, fetchRiskScore, fetchSafePlaces, type RiskContext } from '../services/safetyService';
import { monitoringService } from '../services/monitoringService';
import { fetchCurrentWeather } from '../services/weatherService';
import type { RiskScore, Coordinates, SafeWalkStatus } from '../types';

const DISTRESS_KEYWORDS = ['help', 'bachao', 'stop', 'no', 'emergency'];
const AUDIO_SPIKE_THRESHOLD = 0.15;   // RMS 0–1 scale: 0.15 ≈ sustained loud noise
const IMPACT_THRESHOLD = 25;          // m/s² (gravity alone ≈ 9.8; sharp impact > 25)
const ANOMALY_WINDOW_MS = 5000;       // Two anomalies within 5 s → suspicious
const ESCALATION_TIMEOUT_MS = 10000; // 10 s in suspicious without reset → emergency
const MONITORING_UPDATE_MS = 30000;
const DEFAULT_LOCATION = { lat: 28.6139, lng: 77.2090 };

function isValidLocation(location: Coordinates | null | undefined): location is Coordinates {
  return Number.isFinite(location?.lat) && Number.isFinite(location?.lng);
}

function toAlertRiskLevel(score: number): 'Low' | 'Medium' | 'High' | 'Critical' {
  if (score >= 80) return 'Critical';
  if (score >= 60) return 'High';
  if (score >= 35) return 'Medium';
  return 'Low';
}

/** All persistent sensor resources held in a single bag for atomic cleanup */
interface SensorResources {
  geoWatchId: number | null;
  audioCtx: AudioContext | null;
  analyser: AnalyserNode | null;
  stream: MediaStream | null;
  recognition: any;
  animFrame: number | null;
  motionHandler: ((e: DeviceMotionEvent) => void) | null;
  wakeLock: any;
  silentAudio: HTMLAudioElement | null;
}

function makeSensorResources(): SensorResources {
  return {
    geoWatchId: null,
    audioCtx: null,
    analyser: null,
    stream: null,
    recognition: null,
    animFrame: null,
    motionHandler: null,
    wakeLock: null,
    silentAudio: null,
  };
}

/** Atomically release all held sensor resources */
function releaseSensorResources(res: SensorResources) {
  if (res.geoWatchId !== null) {
    navigator.geolocation.clearWatch(res.geoWatchId);
    res.geoWatchId = null;
  }
  if (res.animFrame !== null) {
    cancelAnimationFrame(res.animFrame);
    res.animFrame = null;
  }
  if (res.silentAudio) {
    res.silentAudio.pause();
    res.silentAudio.src = '';
    res.silentAudio = null;
  }
  // Stop mic tracks first, then close the AudioContext
  if (res.stream) {
    res.stream.getTracks().forEach(t => t.stop());
    res.stream = null;
  }
  res.analyser = null;
  if (res.audioCtx && res.audioCtx.state !== 'closed') {
    res.audioCtx.close().catch(() => { });
    res.audioCtx = null;
  }
  if (res.recognition) {
    try { res.recognition.stop(); } catch (_) { }
    res.recognition = null;
  }
  if (res.motionHandler) {
    window.removeEventListener('devicemotion', res.motionHandler);
    res.motionHandler = null;
  }
  if (res.wakeLock) {
    res.wakeLock.release().catch(() => { });
    res.wakeLock = null;
  }
}

export function useSmartSafeWalk(liveLocation: Coordinates | null = null) {
  const { user } = useAuth();
  const { guardians } = useGuardians();
  const [status, setStatus] = useState<SafeWalkStatus>('idle');
  const [riskScore, setRiskScore] = useState<RiskScore | null>(null);

  // Use a ref so callbacks always see current status without re-creating them
  const statusRef = useRef<SafeWalkStatus>('idle');
  const locationRef = useRef<Coordinates | null>(null);
  const speedRef = useRef(0);
  const stopsRef = useRef(0);
  const lastGeoUpdate = useRef(0);

  const anomalyTimestamps = useRef<number[]>([]);
  const escalationTimer = useRef<number | null>(null);
  const riskInterval = useRef<number | null>(null);
  const monitoringSessionId = useRef<string | null>(null);
  const autoEmergencyTriggered = useRef(false);
  const sensors = useRef<SensorResources>(makeSensorResources());

  // Keep statusRef in sync with state
  const updateStatus = useCallback((s: SafeWalkStatus) => {
    statusRef.current = s;
    setStatus(s);
  }, []);

  const readBatteryLevel = useCallback(async () => {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level?: number }> };
    if (!nav.getBattery) return undefined;
    const battery = await nav.getBattery();
    return typeof battery.level === 'number' ? Math.round(battery.level * 100) : undefined;
  }, []);

  useEffect(() => {
    if (isValidLocation(liveLocation)) {
      locationRef.current = liveLocation;
      lastGeoUpdate.current = Date.now();
    }
  }, [liveLocation]);

  const collectSnapshotData = useCallback(async () => {
    const location = isValidLocation(liveLocation)
      ? liveLocation
      : isValidLocation(locationRef.current)
        ? locationRef.current
        : DEFAULT_LOCATION;
    const weather = await fetchCurrentWeather(location.lat, location.lng);
    const safePlaces = await fetchSafePlaces(location);
    const ctx: RiskContext = {
      location,
      currentSpeed: speedRef.current,
      recentStops: stopsRef.current,
      isOnUsualRoute: true,
      weather,
    };
    const score = await fetchRiskScore(ctx);

    return {
      location,
      weather,
      safePlaces,
      score,
      batteryLevel: await readBatteryLevel(),
      nearbyPoliceStations: safePlaces.filter((place) => place.type === 'police'),
      nearbyHospitals: safePlaces.filter((place) => place.type === 'hospital'),
    };
  }, [liveLocation, readBatteryLevel]);

  /** ---------- Escalation Engine ---------- */
  const escalateToEmergency = useCallback(async () => {
    if (statusRef.current === 'emergency') return;
    updateStatus('emergency');
    const loc = locationRef.current ?? DEFAULT_LOCATION;
    try {
      await triggerEmergencyAlert(loc, guardians, user);
      await sendMonitoringSnapshot(true);
    } catch (err) {
      console.error('[SafeWalk] Emergency alert failed:', err);
    }
  }, [guardians, updateStatus, user]);

  const checkAutoEmergencyRisk = useCallback((score?: number) => {
    if (
      score !== undefined &&
      score >= 65 &&
      statusRef.current !== 'emergency' &&
      !autoEmergencyTriggered.current
    ) {
      autoEmergencyTriggered.current = true;
      escalateToEmergency();
    }
  }, [escalateToEmergency]);

  const sendMonitoringSnapshot = useCallback(async (isSos = false) => {
    if (!user || !monitoringSessionId.current) return;

    const snapshot = await collectSnapshotData();
    setRiskScore(snapshot.score);

    if (!isSos) {
      checkAutoEmergencyRisk(snapshot.score?.score);
    }

    await monitoringService.update({
      userId: user.id,
      sessionId: monitoringSessionId.current,
      location: snapshot.location,
      riskScore: snapshot.score,
      weather: snapshot.weather,
      safePlaces: snapshot.safePlaces,
      guardians,
      walkingSpeedKmph: speedRef.current,
      stoppedUnexpectedly: stopsRef.current > 0,
      longInactivity: Date.now() - lastGeoUpdate.current > MONITORING_UPDATE_MS * 2,
      isSos,
      batteryLevel: snapshot.batteryLevel,
    });
  }, [checkAutoEmergencyRisk, collectSnapshotData, guardians, user]);

  const recordAnomaly = useCallback((source: string) => {
    if (statusRef.current === 'emergency') return;

    console.warn(`[SafeWalk] Anomaly ← ${source}`);
    const now = Date.now();
    anomalyTimestamps.current = anomalyTimestamps.current.filter(t => now - t < ANOMALY_WINDOW_MS);
    anomalyTimestamps.current.push(now);

    if (anomalyTimestamps.current.length >= 2 && statusRef.current === 'monitoring') {
      updateStatus('suspicious');
      escalationTimer.current = window.setTimeout(() => {
        escalateToEmergency();
      }, ESCALATION_TIMEOUT_MS);
    }
  }, [updateStatus, escalateToEmergency]);

  /** ---------- Start sensors ---------- */
  const startSensors = useCallback(async () => {
    const res = sensors.current;

    // 1. GPS / Location
    if (navigator.geolocation) {
      res.geoWatchId = navigator.geolocation.watchPosition(
        (pos) => {
          const now = Date.now();
          if (now - lastGeoUpdate.current < 2000) return; // throttle 2s
          lastGeoUpdate.current = now;

          const { latitude, longitude, accuracy, speed } = pos.coords;
          locationRef.current = { lat: latitude, lng: longitude, accuracy };

          const kmh = (speed ?? 0) * 3.6;
          if (speedRef.current > 10 && kmh < 1) {
            stopsRef.current++;
            recordAnomaly('Sudden Stop');
          }
          speedRef.current = kmh;
        },
        (err) => console.error('[SafeWalk] GPS error', err),
        { enableHighAccuracy: true, maximumAge: 0 }
      );
    }

    // 2. DeviceMotion
    const motionHandler = (event: DeviceMotionEvent) => {
      const acc = event.accelerationIncludingGravity;
      if (!acc || acc.x === null || acc.y === null || acc.z === null) return;
      const mag = Math.sqrt(acc.x ** 2 + acc.y ** 2 + acc.z ** 2);
      if (mag > IMPACT_THRESHOLD) recordAnomaly('Motion Impact');
    };
    res.motionHandler = motionHandler;
    window.addEventListener('devicemotion', motionHandler);

    // 3. Microphone / Audio (with graceful degradation)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      res.stream = stream;

      const AudioCtxClass = window.AudioContext ?? (window as any).webkitAudioContext;
      if (AudioCtxClass) {
        const audioCtx = new AudioCtxClass() as AudioContext;
        res.audioCtx = audioCtx;

        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        res.analyser = analyser;

        audioCtx.createMediaStreamSource(stream).connect(analyser);

        const data = new Uint8Array(analyser.frequencyBinCount);
        let lastSpike = 0;

        const tick = () => {
          // Stop ticking if sensors were released
          if (!res.analyser || !res.audioCtx || res.audioCtx.state === 'closed') return;

          analyser.getByteTimeDomainData(data);
          let sq = 0;
          for (let i = 0; i < data.length; i++) {
            const n = (data[i] / 128) - 1;
            sq += n * n;
          }
          const rms = Math.sqrt(sq / data.length);

          if (rms > AUDIO_SPIKE_THRESHOLD && Date.now() - lastSpike > 1500) {
            lastSpike = Date.now();
            recordAnomaly('Audio Spike (Loud Noise/Scream)');
          }

          res.animFrame = requestAnimationFrame(tick);
        };
        res.animFrame = requestAnimationFrame(tick);
      }

      // Layer 2: Speech Recognition (best-effort; silently skipped if unsupported)
      const SpeechRec = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
      if (SpeechRec) {
        const recognition = new SpeechRec();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.onresult = (e: any) => {
          const text = (e.results[e.resultIndex][0]?.transcript ?? '').toLowerCase();
          if (DISTRESS_KEYWORDS.some(kw => text.includes(kw))) {
            recordAnomaly('Distress Keyword Detected');
            recordAnomaly('Distress Keyword (High Confidence Boost)');
          }
        };
        recognition.onerror = () => { }; // silence non-fatal errors
        recognition.start();
        res.recognition = recognition;
      }
    } catch (_) {
      console.warn('[SafeWalk] Microphone denied — running on location + motion only.');
    }

    // 4. Silent Audio Background Hack (Keeps JS execution thread alive on mobile lock screen)
    try {
      const silentAudio = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==');
      silentAudio.loop = true;
      await silentAudio.play();
      res.silentAudio = silentAudio;
    } catch (_) {
      console.warn('[SafeWalk] Silent audio background keep-alive failed or blocked by browser autoplay policy.');
    }

    // 5. Screen Wake Lock
    if ('wakeLock' in navigator) {
      try {
        res.wakeLock = await (navigator as any).wakeLock.request('screen');
      } catch (_) {
        console.warn('[SafeWalk] Wake Lock unavailable.');
      }
    }
  }, [recordAnomaly]);

  /** ---------- Public Controls ---------- */
  const startWalk = useCallback(async () => {
    autoEmergencyTriggered.current = false;
    anomalyTimestamps.current = [];
    speedRef.current = 0;
    stopsRef.current = 0;
    lastGeoUpdate.current = 0;
    updateStatus('monitoring');
    await startSensors();

    const snapshot = await collectSnapshotData();
    setRiskScore(snapshot.score);

    const userId = user?.id || 'guest_000';
    try {
      const session = await monitoringService.start(userId, snapshot.location, {
        currentSafeScore: snapshot.score.score,
        currentRiskLevel: toAlertRiskLevel(snapshot.score.score),
        weather: snapshot.weather,
        nearbySafePlaces: snapshot.safePlaces,
        nearbyPoliceStations: snapshot.nearbyPoliceStations,
        nearbyHospitals: snapshot.nearbyHospitals,
        aiInsight: {
          message: snapshot.score.factors[0] ?? 'Safe Walk monitoring active.',
          tone: 'advisory',
          createdAt: new Date().toISOString(),
        },
        batteryLevel: snapshot.batteryLevel,
        walkingSpeedKmph: speedRef.current,
        dayNight: snapshot.weather.isDay ? 'day' : 'night',
        timestamp: new Date().toISOString(),
        guardians,
      });
      monitoringSessionId.current = session._id;
    } catch (err) {
      console.warn('[SafeWalk] Backend monitoring session failed to start:', err);
    }

    checkAutoEmergencyRisk(snapshot.score?.score);

    // Start risk scoring and backend snapshots.
    riskInterval.current = window.setInterval(async () => {
      if (statusRef.current === 'idle') return;
      try {
        await sendMonitoringSnapshot();
      } catch (_) {
        // Silently ignore API errors during walk (rate limits etc.)
      }
    }, MONITORING_UPDATE_MS);
  }, [checkAutoEmergencyRisk, collectSnapshotData, guardians, sendMonitoringSnapshot, startSensors, updateStatus, user]);

  const stopWalk = useCallback(async () => {
    autoEmergencyTriggered.current = false;
    if (escalationTimer.current) {
      clearTimeout(escalationTimer.current);
      escalationTimer.current = null;
    }
    if (riskInterval.current) {
      clearInterval(riskInterval.current);
      riskInterval.current = null;
    }
    releaseSensorResources(sensors.current);
    sensors.current = makeSensorResources(); // fresh bag for next walk
    anomalyTimestamps.current = [];
    if (monitoringSessionId.current) {
      try {
        await monitoringService.stop(user?.id || 'guest_000', monitoringSessionId.current, locationRef.current ?? undefined, guardians);
      } catch (err) {
        console.warn('[SafeWalk] Backend monitoring session failed to stop:', err);
      }
    }
    monitoringSessionId.current = null;
    updateStatus('idle');
    setRiskScore(null);
  }, [guardians, updateStatus, user]);

  const confirmSafe = useCallback(() => {
    // User manually confirms they are safe — cancel escalation
    if (escalationTimer.current) {
      clearTimeout(escalationTimer.current);
      escalationTimer.current = null;
    }
    anomalyTimestamps.current = [];
    updateStatus('monitoring');
  }, [updateStatus]);

  // Global unmount cleanup
  useEffect(() => {
    return () => {
      if (escalationTimer.current) clearTimeout(escalationTimer.current);
      if (riskInterval.current) clearInterval(riskInterval.current);
      releaseSensorResources(sensors.current);
    };
  }, []);

  return { status, riskScore, startWalk, stopWalk, confirmSafe };
}
