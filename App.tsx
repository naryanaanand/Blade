import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GameState, LevelData, GameObject, TrailPoint, Particle } from './types';
import { generateLevel } from './services/gemini';
import { Button } from './components/Button';
import { Sword, Zap, RefreshCw, Trophy, AlertCircle } from 'lucide-react';

// --- Constants & Config ---
const MOTION_THRESHOLD = 35; // Increased to ignore camera grain
const MIN_MOVEMENT_PIXELS = 45; // Minimum pixels that must change to register movement (avoids jitter)
const DOWNSAMPLE_FACTOR = 8; // Low res for performance
const MOTION_SENSITIVITY = 2.5; 
const GRAVITY = 0.25; // Slightly heavier feel
const SPAWN_RATE = 900; 
const MAX_TRAIL_LENGTH = 14; // Shorter but smoother
const BLADE_WIDTH = 25;
const BLADE_COLOR_CORE = '#ffffff';
const BLADE_COLOR_OUTER = '#0ea5e9'; // Cyan

const App: React.FC = () => {
  // --- State ---
  const [gameState, setGameState] = useState<GameState>(GameState.MENU);
  const [levelData, setLevelData] = useState<LevelData | null>(null);
  const [score, setScore] = useState(0);
  const [combo, setCombo] = useState(0);
  const [lives, setLives] = useState(3);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [permissionGranted, setPermissionGranted] = useState(false);

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null); 
  const motionCanvasRef = useRef<HTMLCanvasElement>(null); 
  const requestRef = useRef<number>(0);
  const prevFrameDataRef = useRef<Uint8ClampedArray | null>(null);
  
  // Game Entities
  const objectsRef = useRef<GameObject[]>([]);
  const trailRef = useRef<TrailPoint[]>([]);
  const particlesRef = useRef<Particle[]>([]);
  const lastSpawnTimeRef = useRef<number>(0);
  const scoreRef = useRef(0); 
  const comboRef = useRef(0);
  const comboTimerRef = useRef<any>(null);
  const livesRef = useRef(3);
  const swordPosRef = useRef({ x: 320, y: 240 }); // Start center
  const gridOffsetRef = useRef(0);

  // --- Sound ---
  const playSound = useCallback((type: 'slash' | 'hit' | 'wrong' | 'combo') => {
    try {
      const AudioContext = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContext) return;
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      if (type === 'slash') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(600, now);
        osc.frequency.exponentialRampToValueAtTime(100, now + 0.1);
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.15);
      } else if (type === 'hit') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(400, now);
        osc.frequency.exponentialRampToValueAtTime(800, now + 0.1);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.15);
        osc.start(now);
        osc.stop(now + 0.2);
      } else if (type === 'wrong') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(100, now);
        osc.frequency.linearRampToValueAtTime(50, now + 0.4);
        gain.gain.setValueAtTime(0.4, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
        osc.start(now);
        osc.stop(now + 0.4);
      } else if (type === 'combo') {
        osc.type = 'square';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.exponentialRampToValueAtTime(1200, now + 0.1);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.linearRampToValueAtTime(0, now + 0.3);
        osc.start(now);
        osc.stop(now + 0.3);
      }
    } catch (e) { /* ignore */ }
  }, []);

  // --- Game Logic Helpers ---
  const incrementCombo = () => {
    comboRef.current += 1;
    setCombo(comboRef.current);
    if (comboRef.current > 1) playSound('combo');
    
    if (comboTimerRef.current) clearTimeout(comboTimerRef.current);
    comboTimerRef.current = setTimeout(() => {
      comboRef.current = 0;
      setCombo(0);
    }, 1500);
  };

  const createSplatter = (x: number, y: number, color: string) => {
    const count = 16;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = Math.random() * 8 + 3;
      particlesRef.current.push({
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1.0,
        color,
        size: Math.random() * 5 + 2
      });
    }
  };

  // --- Vision Engine ---
  const detectMotion = () => {
    const video = videoRef.current;
    const motionCanvas = motionCanvasRef.current;
    if (!video || !motionCanvas || video.readyState !== 4) return null;

    const ctx = motionCanvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    const w = motionCanvas.width;
    const h = motionCanvas.height;
    
    // Mirror and draw
    ctx.save();
    ctx.scale(-1, 1);
    ctx.drawImage(video, -w, 0, w, h);
    ctx.restore();

    const frameData = ctx.getImageData(0, 0, w, h).data;
    
    if (!prevFrameDataRef.current) {
      prevFrameDataRef.current = frameData;
      return null;
    }

    const prevData = prevFrameDataRef.current;
    let sumX = 0;
    let sumY = 0;
    let count = 0;

    // We scan pixels. If enough pixels change color significantly, we have movement.
    for (let i = 0; i < frameData.length; i += 4) { 
      const rDiff = Math.abs(frameData[i] - prevData[i]);
      const gDiff = Math.abs(frameData[i + 1] - prevData[i + 1]);
      const bDiff = Math.abs(frameData[i + 2] - prevData[i + 2]);
      
      // Strict threshold to avoid camera noise
      if (rDiff + gDiff + bDiff > MOTION_THRESHOLD * 3) {
        const pixelIndex = i / 4;
        sumX += pixelIndex % w;
        sumY += Math.floor(pixelIndex / w);
        count++;
      }
    }

    prevFrameDataRef.current = frameData;

    // GATING: Only register if a significant cluster moved (e.g. a hand, not a dust speck)
    if (count > MIN_MOVEMENT_PIXELS) {
      const rawX = (sumX / count) * DOWNSAMPLE_FACTOR;
      const rawY = (sumY / count) * DOWNSAMPLE_FACTOR;

      const centerX = 640 / 2;
      const centerY = 480 / 2;
      
      // Amplification
      let amplifiedX = centerX + (rawX - centerX) * MOTION_SENSITIVITY;
      let amplifiedY = centerY + (rawY - centerY) * MOTION_SENSITIVITY;

      amplifiedX = Math.max(0, Math.min(640, amplifiedX));
      amplifiedY = Math.max(0, Math.min(480, amplifiedY));

      return { x: amplifiedX, y: amplifiedY };
    }
    return null;
  };

  const spawnObject = (width: number, height: number) => {
    if (!levelData) return;
    const isTarget = Math.random() > 0.35; 
    const list = isTarget ? levelData.targets : levelData.distractors;
    const text = list[Math.floor(Math.random() * list.length)];

    objectsRef.current.push({
      id: Math.random().toString(36).substr(2, 9),
      text,
      x: Math.random() * (width - 200) + 100,
      y: height + 80,
      vx: (Math.random() - 0.5) * 6, 
      vy: -(Math.random() * 8 + 13), 
      rotation: 0,
      vRotation: (Math.random() - 0.5) * 0.15,
      isTarget,
      radius: 50,
      sliced: false,
      color: isTarget ? '#34d399' : '#f87171',
    });
  };

  const checkCollision = (p1: TrailPoint, p2: TrailPoint, obj: GameObject) => {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const lenSq = dx * dx + dy * dy;
    let t = ((obj.x - p1.x) * dx + (obj.y - p1.y) * dy) / lenSq;
    t = Math.max(0, Math.min(1, t));
    const closestX = p1.x + t * dx;
    const closestY = p1.y + t * dy;
    const distSq = (obj.x - closestX) ** 2 + (obj.y - closestY) ** 2;
    return distSq < obj.radius * obj.radius;
  };

  // --- Rendering ---
  const drawGrid = (ctx: CanvasRenderingContext2D, width: number, height: number) => {
    ctx.save();
    ctx.strokeStyle = 'rgba(14, 165, 233, 0.15)';
    ctx.lineWidth = 1;
    
    // Perspective Grid effect
    gridOffsetRef.current = (gridOffsetRef.current + 0.5) % 40;
    const horizon = height * 0.7;
    
    // Vertical lines (fan out)
    for (let i = -10; i <= 20; i++) {
      ctx.beginPath();
      ctx.moveTo(width / 2 + i * 40, horizon);
      ctx.lineTo(width / 2 + i * 180, height);
      ctx.stroke();
    }

    // Horizontal lines (move down)
    for (let i = 0; i < 15; i++) {
      const y = horizon + i * 30 + gridOffsetRef.current;
      if (y > height) continue;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    
    // Horizon Glow
    const grad = ctx.createLinearGradient(0, horizon - 50, 0, horizon + 50);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, 'rgba(14, 165, 233, 0.4)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, horizon - 50, width, 100);
    
    ctx.restore();
  };

  const drawBlade = (ctx: CanvasRenderingContext2D) => {
    const points = trailRef.current;
    if (points.length < 3) return;

    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Additive blending for light effect
    ctx.globalCompositeOperation = 'lighter';

    // Draw Outer Glow
    ctx.shadowBlur = 20;
    ctx.shadowColor = BLADE_COLOR_OUTER;
    
    ctx.beginPath();
    // Start at the oldest point
    ctx.moveTo(points[points.length - 1].x, points[points.length - 1].y);

    // Quadratic bezier curve through the points for smoothness
    for (let i = points.length - 2; i >= 1; i--) {
      const p1 = points[i];
      const p2 = points[i - 1];
      const midX = (p1.x + p2.x) / 2;
      const midY = (p1.y + p2.y) / 2;
      ctx.quadraticCurveTo(p1.x, p1.y, midX, midY);
    }
    // Connect to last point (tip)
    ctx.lineTo(points[0].x, points[0].y);

    // Stroke style
    ctx.strokeStyle = BLADE_COLOR_OUTER;
    ctx.lineWidth = 12;
    ctx.stroke();

    // Draw Inner Core (White hot)
    ctx.lineWidth = 4;
    ctx.strokeStyle = BLADE_COLOR_CORE;
    ctx.stroke();

    ctx.restore();
  };

  const gameLoop = useCallback((time: number) => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    
    if (!canvas || !ctx || gameState !== GameState.PLAYING) {
      if (gameState === GameState.PLAYING) requestRef.current = requestAnimationFrame(gameLoop);
      return;
    }

    // 1. Physics & Logic
    const motion = detectMotion();
    if (motion) {
      // Smooth Lerp for less jitter
      swordPosRef.current.x += (motion.x - swordPosRef.current.x) * 0.5;
      swordPosRef.current.y += (motion.y - swordPosRef.current.y) * 0.5;
      
      trailRef.current.unshift({ 
        x: swordPosRef.current.x, 
        y: swordPosRef.current.y, 
        life: 1.0 
      });
      
      // Play slash sound if moving fast
      if (trailRef.current.length > 2) {
        const p1 = trailRef.current[0];
        const p2 = trailRef.current[2]; // Compare current to 2 frames ago
        const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (dist > 50) playSound('slash');
      }
    } else {
       // No motion detected? Slowly fade trail but keep last known pos
       if (trailRef.current.length > 0) {
           // Optional: drift the sword to center or just stay? Staying is better.
       }
    }

    trailRef.current.forEach(p => p.life -= 0.12);
    trailRef.current = trailRef.current.filter(p => p.life > 0);

    particlesRef.current.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.15;
      p.life -= 0.03;
    });
    particlesRef.current = particlesRef.current.filter(p => p.life > 0);

    objectsRef.current.forEach(obj => {
      obj.x += obj.vx;
      obj.y += obj.vy;
      obj.vy += GRAVITY;
      obj.rotation += obj.vRotation;

      if (!obj.sliced && trailRef.current.length > 2) {
        // Check multiple segments of the blade for better hit detection
        for (let i = 0; i < Math.min(5, trailRef.current.length - 1); i++) {
           if (checkCollision(trailRef.current[i], trailRef.current[i+1], obj)) {
              obj.sliced = true;
              createSplatter(obj.x, obj.y, obj.color);
              
              if (obj.isTarget) {
                scoreRef.current += 10 + (comboRef.current * 2);
                setScore(scoreRef.current);
                incrementCombo();
                playSound('hit');
              } else {
                livesRef.current -= 1;
                setLives(livesRef.current);
                comboRef.current = 0;
                setCombo(0);
                playSound('wrong');
                if (livesRef.current <= 0) setGameState(GameState.GAME_OVER);
              }
              break; 
           }
        }
      }
    });
    
    objectsRef.current = objectsRef.current.filter(obj => 
      obj.y < canvas.height + 100 && !(obj.sliced)
    );

    if (time - lastSpawnTimeRef.current > SPAWN_RATE) {
      spawnObject(canvas.width, canvas.height);
      lastSpawnTimeRef.current = time;
    }

    // 2. Rendering
    // Clear and fill background
    ctx.fillStyle = '#0f172a'; // Slate 900 base
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Draw subtle Video Feed
    if (videoRef.current) {
      ctx.save();
      ctx.globalAlpha = 0.15;
      ctx.scale(-1, 1);
      ctx.drawImage(videoRef.current, -canvas.width, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    ctx.globalAlpha = 1.0;

    drawGrid(ctx, canvas.width, canvas.height);

    // Particles with additive blending
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    particlesRef.current.forEach(p => {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.globalAlpha = p.life;
      ctx.fill();
    });
    ctx.restore();

    // Objects
    objectsRef.current.forEach(obj => {
      if (obj.sliced) return; 

      ctx.save();
      ctx.translate(obj.x, obj.y);
      ctx.rotate(obj.rotation);
      
      // Glow
      ctx.shadowColor = obj.color;
      ctx.shadowBlur = 15;
      
      // Bubble
      ctx.beginPath();
      ctx.arc(0, 0, obj.radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(30, 41, 59, 0.8)'; // Slate 800
      ctx.fill();
      ctx.lineWidth = 3;
      ctx.strokeStyle = obj.color;
      ctx.stroke();

      // Text
      ctx.shadowBlur = 0;
      ctx.rotate(obj.rotation * -0.9); // Counter-rotate slightly
      ctx.fillStyle = '#fff';
      ctx.font = '700 18px Poppins';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(obj.text, 0, 0);
      
      ctx.restore();
    });

    drawBlade(ctx);

    requestRef.current = requestAnimationFrame(gameLoop);
  }, [gameState, levelData]);


  // --- Setup ---
  useEffect(() => {
    if (gameState === GameState.PLAYING) {
      requestRef.current = requestAnimationFrame(gameLoop);
    }
    return () => cancelAnimationFrame(requestRef.current);
  }, [gameState, gameLoop]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          width: { ideal: 640 }, 
          height: { ideal: 480 },
          facingMode: "user"
        } 
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play();
          if (canvasRef.current && motionCanvasRef.current) {
            canvasRef.current.width = 640; 
            canvasRef.current.height = 480;
            motionCanvasRef.current.width = 640 / DOWNSAMPLE_FACTOR;
            motionCanvasRef.current.height = 480 / DOWNSAMPLE_FACTOR;
            setPermissionGranted(true);
          }
        };
      }
    } catch (e) {
      setErrorMsg("Camera access required.");
      setGameState(GameState.ERROR);
    }
  };

  const initializeGame = async () => {
    setGameState(GameState.LOADING_LEVEL);
    try {
      if (!permissionGranted) await startCamera();
      const level = await generateLevel();
      setLevelData(level);
      setScore(0);
      setCombo(0);
      setLives(3);
      scoreRef.current = 0;
      comboRef.current = 0;
      livesRef.current = 3;
      objectsRef.current = [];
      trailRef.current = [];
      particlesRef.current = [];
      setGameState(GameState.PLAYING);
    } catch (e) {
      setErrorMsg("AI Dojo disconnected.");
      setGameState(GameState.ERROR);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center overflow-hidden font-sans">
      
      {/* HUD */}
      <div className="absolute top-0 left-0 right-0 p-6 z-20 flex justify-between items-start bg-gradient-to-b from-black/80 to-transparent h-32 pointer-events-none">
        <div>
          <div className="flex items-center gap-2 mb-1">
             <Zap className="text-cyan-400 fill-cyan-400 h-6 w-6 animate-pulse" />
             <h1 className="font-black text-2xl italic tracking-tighter text-transparent bg-clip-text bg-gradient-to-r from-cyan-400 via-white to-cyan-400">NEON BLADE</h1>
          </div>
          {levelData && (
             <div className="bg-cyan-900/30 backdrop-blur-sm border-l-4 border-cyan-400 px-3 py-1">
               <p className="text-cyan-100 text-sm font-bold uppercase tracking-widest">{levelData.themeName}</p>
             </div>
          )}
        </div>

        {gameState === GameState.PLAYING && (
           <div className="flex flex-col items-end gap-2">
             <div className="flex items-center gap-4">
               <div className="text-right">
                 <p className="text-xs text-slate-400 font-mono uppercase">Score</p>
                 <p className="text-3xl font-black font-mono text-white drop-shadow-[0_0_10px_rgba(255,255,255,0.5)]">{score}</p>
               </div>
               <div className="h-10 w-[2px] bg-slate-700"></div>
               <div className="text-right">
                 <p className="text-xs text-slate-400 font-mono uppercase">Lives</p>
                 <div className="flex gap-1">
                   {[...Array(3)].map((_, i) => (
                     <div key={i} className={`w-6 h-6 rounded-sm transform rotate-45 transition-all duration-300 ${i < lives ? 'bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.6)]' : 'bg-slate-800'}`} />
                   ))}
                 </div>
               </div>
             </div>
             {combo > 1 && (
               <div className="text-4xl font-black italic text-yellow-400 animate-bounce drop-shadow-[0_0_15px_rgba(250,204,21,0.8)]">
                 {combo}x COMBO!
               </div>
             )}
           </div>
        )}
      </div>

      {/* Game Viewport */}
      <div className="relative w-full max-w-4xl aspect-[4/3] bg-slate-900 rounded-xl overflow-hidden shadow-[0_0_80px_rgba(6,182,212,0.15)] ring-1 ring-slate-800">
        <video ref={videoRef} className="hidden" playsInline muted />
        <canvas ref={motionCanvasRef} className="hidden" />
        <canvas ref={canvasRef} className={`w-full h-full object-cover ${gameState === GameState.PLAYING ? 'cursor-none' : ''}`} />

        {/* Menus */}
        {gameState === GameState.MENU && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm z-30">
            <div className="relative p-12 text-center max-w-lg">
              <div className="absolute inset-0 bg-cyan-500/5 blur-3xl rounded-full"></div>
              <div className="relative">
                <Sword size={80} className="mx-auto text-cyan-400 mb-8 drop-shadow-[0_0_30px_rgba(34,211,238,0.6)] animate-pulse" />
                <h2 className="text-6xl font-black mb-2 italic tracking-tighter text-white">AI DOJO</h2>
                <p className="text-cyan-200 mb-10 text-xl font-light">
                  Wield your hand as the Neon Blade. <br/>
                  <span className="text-sm opacity-70 mt-2 block">(Make sure you have good lighting!)</span>
                </p>
                <Button onClick={initializeGame} fullWidth className="text-xl py-5 bg-cyan-500 hover:bg-cyan-400 text-black font-black tracking-widest">
                  ENTER DOJO
                </Button>
              </div>
            </div>
          </div>
        )}

        {gameState === GameState.LOADING_LEVEL && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/95 z-30">
            <div className="w-16 h-16 border-4 border-cyan-500/30 border-t-cyan-400 rounded-full animate-spin mb-6"></div>
            <p className="text-cyan-400 font-mono animate-pulse tracking-widest">GENERATING NEURAL TRAINING...</p>
          </div>
        )}

        {gameState === GameState.PLAYING && levelData && (
          <div className="absolute top-32 w-full flex justify-center z-10 pointer-events-none animate-in fade-in slide-in-from-top-4 duration-700">
             <div className="px-8 py-3 bg-black/60 backdrop-blur-xl rounded-2xl border border-white/10 shadow-2xl">
               <h3 className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-green-300 to-emerald-500 drop-shadow-sm">
                 {levelData.instruction}
               </h3>
             </div>
          </div>
        )}

        {gameState === GameState.GAME_OVER && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 backdrop-blur-lg z-30 animate-in fade-in zoom-in duration-300">
            <Trophy size={80} className="text-yellow-400 mb-6 drop-shadow-[0_0_30px_rgba(250,204,21,0.6)]" />
            <h2 className="text-7xl font-black text-white mb-4 italic tracking-tighter">GAME OVER</h2>
            <div className="text-4xl text-cyan-300 mb-12 font-mono bg-cyan-900/20 px-8 py-2 rounded-lg border border-cyan-500/30">
              SCORE: <span className="text-white">{score}</span>
            </div>
            <Button onClick={initializeGame} className="px-12 py-4 text-xl bg-white text-black hover:bg-slate-200 font-bold">
              <RefreshCw className="inline-block mr-3" size={24} /> PLAY AGAIN
            </Button>
          </div>
        )}

        {gameState === GameState.ERROR && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-900 z-30">
            <AlertCircle size={64} className="text-red-500 mb-4" />
            <p className="text-red-400 mb-6 text-center px-4 text-xl font-bold">{errorMsg}</p>
            <Button onClick={initializeGame} variant="secondary">TRY AGAIN</Button>
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
