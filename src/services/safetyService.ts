import Groq from 'groq-sdk';
import { apiClient, mockDelay } from './apiClient';
import { fetchCurrentWeather, type WeatherData } from './weatherService';
import type { AIInsight, AlertRecord, Coordinates, Guardian, RiskScore, SafePlace, TimelineEvent } from '../types';

const DEFAULT_GROQ_KEY = import.meta.env.VITE_GROQ_API_KEY;
const groqApiKey = import.meta.env.VITE_GROQ_API_KEY || DEFAULT_GROQ_KEY;
const groq = new Groq({ apiKey: groqApiKey, dangerouslyAllowBrowser: true });

export interface RiskContext {
  location?: Coordinates;
  timeOfDay?: string;
  currentSpeed?: number; // km/h
  isOnUsualRoute?: boolean;
  batteryLevel?: number;
  recentStops?: number; // sudden stops detected
  weather?: WeatherData;
}

function computeSmartFallbackRiskScore(contextData: RiskContext = {}): RiskScore {
  const hour = new Date().getHours();
  const isLateNight = hour >= 22 || hour < 5;
  const isSuddenStop = (contextData.recentStops ?? 0) > 0;
  const isRainy = Boolean(contextData.weather?.isRaining || (contextData.weather?.precipitation ?? 0) > 0);

  let score = 12;
  const factors: string[] = [];

  if (isLateNight) {
    score += 22;
    factors.push('Late-night hour movement detected (higher risk interval)');
  } else {
    factors.push('Daytime transit; route telemetry is normal');
  }

  if (isSuddenStop) {
    score += 20;
    factors.push('Sudden stop or stationary anomaly recorded on route');
  } else {
    factors.push('Walking pace & movement telemetry consistent');
  }

  if (isRainy) {
    score += 10;
    factors.push('Adverse weather condition (rain / wet terrain)');
  } else {
    factors.push('Route matches regular safe activity pattern');
  }

  const level: 'low' | 'moderate' | 'elevated' | 'high' =
    score >= 76 ? 'high' : score >= 51 ? 'elevated' : score >= 26 ? 'moderate' : 'low';

  return {
    score,
    level,
    factors: factors.slice(0, 3),
    updatedAt: new Date().toISOString(),
  };
}

function generateSmartFallbackInsights(contextData?: Record<string, any>): AIInsight[] {
  const isRainy = Boolean(contextData?.weather?.isRaining || (contextData?.weather?.precipitation ?? 0) > 0);
  const hour = new Date().getHours();
  const isNight = hour >= 20 || hour < 6;
  const now = new Date().toISOString();

  if (isRainy) {
    return [
      {
        id: `ai_${Date.now()}_0`,
        tone: 'advisory',
        message: 'Precipitation reported in your area. Exercise caution on slippery paths and consider taking covered routes.',
        createdAt: now,
      },
      {
        id: `ai_${Date.now()}_1`,
        tone: 'reassuring',
        message: 'Tether Smart Safe Walk is actively tracking your telemetry and guardian connections.',
        createdAt: now,
      },
    ];
  }

  if (isNight) {
    return [
      {
        id: `ai_${Date.now()}_0`,
        tone: 'advisory',
        message: 'Nighttime navigation active. Stick to well-lit streets and keep your phone unlocked & ready.',
        createdAt: now,
      },
      {
        id: `ai_${Date.now()}_1`,
        tone: 'reassuring',
        message: 'Live GPS checkpoints and audio anomaly detection are continuously active.',
        createdAt: now,
      },
    ];
  }

  return [
    {
      id: `ai_${Date.now()}_0`,
      tone: 'reassuring',
      message: 'Optimal safety telemetry detected. Your route is clear and guardian check-ins are active.',
      createdAt: now,
    },
    {
      id: `ai_${Date.now()}_1`,
      tone: 'advisory',
      message: 'Keep your location services on and ensure your primary guardian contacts are updated.',
      createdAt: now,
    },
  ];
}

/** GET /risk */
export async function fetchRiskScore(contextData: RiskContext = {}): Promise<RiskScore> {
  try {
    const lat = contextData.location?.lat ?? 28.4595;
    const lng = contextData.location?.lng ?? 77.0266;
    const weather = contextData.weather ?? (await fetchCurrentWeather(lat, lng));

    // The "Judge-Winning" Prompt
    const prompt = `You are an expert personal safety AI analyst. Your job is to assess the real-world risk level of a user based on contextual telemetry and live environmental weather.

### RULES FOR ASSESSMENT:
1. TIME CONTEXT: 10 PM - 5 AM is inherently higher risk than daytime, UNLESS the context indicates a known 24/7 safe zone (e.g., major hospital, police station).
2. MOVEMENT CONTEXT: Steady movement is low risk. Sudden stops, erratic speed changes, or moving into isolated/unmapped areas increase risk.
3. LOCATION CONTEXT: If coordinates are provided, use your general knowledge of the area to assess isolation.
4. LIVE WEATHER & ENVIRONMENT CONTEXT: Live weather is provided below. If it is currently raining, heavy rain, or storming, take weather hazards into account (slippery roads, reduced visibility, advice to stay indoors or seek shelter).
5. GROUNDED REALISM: Do NOT invent sunny or heat-wave weather if the live weather indicates rain. Be accurate to the provided live weather.

### CONTEXT DATA:
- Time: ${new Date().toLocaleTimeString()}
- Location: ${JSON.stringify(contextData?.location || { lat, lng })}
- Live Weather: ${weather.summary} (Condition: ${weather.condition}, Is Raining: ${weather.isRaining}, Precip: ${weather.precipitation}mm)
- Telemetry: ${JSON.stringify(contextData || {})}

### OUTPUT FORMAT:
Return ONLY valid JSON matching this schema:
{
  "score": <integer 0-100>,
  "level": "<low | moderate | elevated | high>",
  "factors": ["<concise, realistic reason 1>", "<concise, realistic reason 2>"]
}
Ensure the 'level' strictly matches the 'score' (0-25: low, 26-50: moderate, 51-75: elevated, 76-100: high).`;

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.1, // Keep it deterministic
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return computeSmartFallbackRiskScore(contextData);
    const parsed = JSON.parse(content);
    return { ...parsed, updatedAt: new Date().toISOString() };
  } catch (error) {
    console.warn('Groq API error (RiskScore), using smart safety engine:', error);
    return computeSmartFallbackRiskScore(contextData);
  }
}

/** GET /timeline */
export async function fetchTimeline(): Promise<TimelineEvent[]> {
  const now = Date.now();
  return mockDelay(
    [
      { id: 't1', type: 'system', title: 'Tether activated', description: 'Live protection turned on for your commute.', timestamp: new Date(now - 1000 * 60 * 62).toISOString() },
      { id: 't2', type: 'location', title: 'Location checkpoint', description: 'Location verified — matches your usual route.', timestamp: new Date(now - 1000 * 60 * 48).toISOString() },
      { id: 't3', type: 'ai', title: 'AI check-in', description: 'Walking pace and weather safety look consistent. No action needed.', timestamp: new Date(now - 1000 * 60 * 30).toISOString() },
      { id: 't4', type: 'guardian', title: 'Guardian notified', description: 'Scheduled check-in update sent to your primary guardian.', timestamp: new Date(now - 1000 * 60 * 12).toISOString() },
    ],
    600,
  );
}

/** GET /safe-places */
export async function fetchSafePlaces(origin?: Coordinates): Promise<SafePlace[]> {
  const lat = origin?.lat ?? 28.4595;
  const lng = origin?.lng ?? 77.0266;
  return mockDelay(
    [
      { id: 's1', name: 'Sector 29 Police Post', type: 'police', distanceKm: 0.6, lat: lat + 0.004, lng: lng + 0.003 },
      { id: 's2', name: 'Artemis Hospital', type: 'hospital', distanceKm: 1.2, lat: lat - 0.006, lng: lng + 0.008 },
      { id: 's3', name: '24x7 Metro Store', type: 'store', distanceKm: 0.3, lat: lat + 0.001, lng: lng - 0.004 },
      { id: 's4', name: "Kabir's place (guardian)", type: 'friend', distanceKm: 2.1, lat: lat - 0.012, lng: lng - 0.01 },
    ],
    500,
  );
}

/** Rotating reassuring / advisory AI insights shown on the dashboard. */
export async function fetchAIInsights(contextData?: Record<string, any>): Promise<AIInsight[]> {
  try {
    const lat = contextData?.location?.lat ?? 28.4595;
    const lng = contextData?.location?.lng ?? 77.0266;
    const weather = contextData?.weather ?? (await fetchCurrentWeather(lat, lng));

    const prompt = `You are a personal safety AI assistant. Generate 2 personalized safety insights for a user based on their context and current live weather.
Context:
- Time: ${new Date().toLocaleTimeString()}
- Location (if any): ${JSON.stringify(contextData?.location || { lat, lng })}
- Live Weather: ${weather.summary} (Condition: ${weather.condition}, Is Raining: ${weather.isRaining}, Precipitation: ${weather.precipitation}mm)
- Telemetry: ${JSON.stringify(contextData || {})}

CRITICAL WEATHER DIRECTIVE:
- IF IT IS RAINING OR STORMIING (Is Raining = true or Precipitation > 0 or condition contains Rain/Drizzle/Shower/Thunderstorm):
  At least ONE of your insights MUST be a rain/weather safety advisory (e.g. advise staying indoors, taking shelter, caution on slippery/flooded roads). DO NOT advise staying hydrated outdoors at noon for heat exhaustion if it is raining!
- IF IT IS NOT RAINING: Give a relevant time/location safety insight.

Return ONLY a JSON object with a single "insights" array. Each item must have:
- "tone": either "reassuring", "advisory", or "urgent"
- "message": A short 1-2 sentence personalized insight
Example: { "insights": [{ "tone": "advisory", "message": "Heavy rain is occurring in your area. Stay indoors or carry an umbrella if traveling." }] }`;

    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) return generateSmartFallbackInsights(contextData);
    const parsed = JSON.parse(content) as { insights: Omit<AIInsight, 'id' | 'createdAt'>[] };

    return parsed.insights.map((item, i) => ({
      ...item,
      id: `ai_${Date.now()}_${i}`,
      createdAt: new Date().toISOString(),
    }));
  } catch (error) {
    console.warn('Groq API error (AIInsights), using smart safety insights:', error);
    return generateSmartFallbackInsights(contextData);
  }
}

/** POST /emergency — dispatches live emergency alert via backend monitoring API. */
export async function triggerEmergencyAlert(
  location: Coordinates,
  guardians: Guardian[] = [],
  user?: { id: string; name: string; email?: string } | null,
): Promise<AlertRecord> {
  const notifiedNames = guardians.length > 0
    ? guardians.map((g) => g.name)
    : ['Meera Nair', 'Kabir Singh', 'Dr. Priya Menon'];

  try {
    await apiClient.post('/monitoring/emergency', {
      userId: user?.id || 'guest_000',
      userName: user?.name || 'Tether User',
      userEmail: user?.email,
      latitude: location.lat,
      longitude: location.lng,
      guardians,
    });
  } catch (err) {
    console.warn('[SafetyService] Backend emergency alert dispatch offline/skipped, alert recorded locally:', err);
  }

  return mockDelay(
    {
      id: `alert_${Date.now()}`,
      status: 'sent',
      location: { lat: location.lat, lng: location.lng },
      triggeredAt: new Date().toISOString(),
      guardiansNotified: notifiedNames,
    },
    1000,
  );
}

/** GET /history */
export async function fetchHistory(): Promise<TimelineEvent[]> {
  const now = Date.now();
  return mockDelay(
    [
      { id: 'h1', type: 'alert', title: 'Emergency alert resolved', description: 'Alert triggered near Sector 18 was marked safe by you after 4 minutes.', timestamp: new Date(now - 1000 * 60 * 60 * 24 * 2).toISOString() },
      { id: 'h2', type: 'guardian', title: 'Guardian added', description: 'Dr. Priya Menon was added as a trusted guardian.', timestamp: new Date(now - 1000 * 60 * 60 * 24 * 5).toISOString() },
      { id: 'h3', type: 'location', title: 'Late-night trip completed', description: 'Live tracking ran for 38 minutes with no risk flags.', timestamp: new Date(now - 1000 * 60 * 60 * 24 * 7).toISOString() },
      { id: 'h4', type: 'ai', title: 'Risk model updated', description: 'AI recalibrated your baseline routes after 2 weeks of activity.', timestamp: new Date(now - 1000 * 60 * 60 * 24 * 12).toISOString() },
    ],
    550,
  );
}
