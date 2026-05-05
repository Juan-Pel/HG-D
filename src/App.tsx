import { useState, useEffect, useRef, useCallback } from 'react';
import Peer, { DataConnection } from 'peerjs';
import { v4 as uuidv4 } from 'uuid';
import confetti from 'canvas-confetti';
import { Crown, MessageSquare, AlertCircle, Copy, Trophy, Settings, Dices } from 'lucide-react';
import { TOPICS as FILE_TOPICS } from './data/topics';

// ============================================================================
// Enums & Types
// ============================================================================
export enum GamePhase {
  MENU = 'menu',
  LOBBY = 'lobby',
  ROLES = 'roles',
  TOPIC = 'topic',
  DICE = 'dice',
  DEBATE = 'debate',
  SENTENCE = 'sentence',
  RESULTS = 'results',
  GAMEOVER = 'gameover'
}

export enum TopicMode {
  DEFAULT = 'default',
  CUSTOM = 'custom',
  MIXED = 'mixed'
}

export interface Player {
  id: string;
  name: string;
  score: number;
  isHost: boolean;
}

export interface ChatMessage {
  id: string;
  senderId?: string;
  senderName: string;
  text: string;
  timestamp: number;
}

export interface GameState {
  roomId: string;
  topicMode: TopicMode;
  customTopics: string[];
  phase: GamePhase;
  players: Player[];
  chat: ChatMessage[];
  currentRound: number;
  topic: string;
  godId: string | null;
  hitlerIds: string[];
  gandhiIds: string[];
  criterion: { id: string; name: string; description: string } | null;
  roundWinner: 'hitler' | 'gandhi' | null;
  targetScore: number;
  debateEndTime: number | null; 
  gameWinnerId: string | null;
}

// P2PMessage is used implicitly for parsing peer messages

const P2P_EVENTS = {
  SYNC_STATE: 'SYNC_STATE',
  JOIN_REQUEST: 'JOIN_REQUEST',
  ERROR: 'ERROR',
  CLIENT_ACTION: 'CLIENT_ACTION',
  CHAT_MESSAGE: 'CHAT_MESSAGE',
};

// Use our rich topics as DEFAULT_TOPICS
const DEFAULT_TOPICS = FILE_TOPICS;

const CRITERIA = [
  { id: 'destructivo', name: 'Lo más destructivo', description: '¿Quién argumenta mejor que esto destruirá a la humanidad?' },
  { id: 'sagrado', name: 'Lo más sagrado', description: '¿Quién prueba mejor que esto es una bendición divina?' },
  { id: 'absurdo', name: 'Lo más absurdo', description: '¿Quién da el argumento más ridículo e hilarante?' },
  { id: 'rentable', name: 'Lo más rentable', description: '¿Quién explica mejor cómo hacerse millonario con esto?' }
];

const INITIAL_STATE: GameState = {
  roomId: '',
  topicMode: TopicMode.DEFAULT,
  customTopics: [],
  phase: GamePhase.MENU,
  players: [],
  chat: [],
  currentRound: 1,
  topic: '',
  godId: null,
  hitlerIds: [],
  gandhiIds: [],
  criterion: null,
  roundWinner: null,
  targetScore: 3,
  debateEndTime: null,
  gameWinnerId: null
};

const getRandomItem = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];
const generateRoomCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();
const systemMessage = (text: string): ChatMessage => ({
  id: uuidv4(),
  senderName: 'Sistema',
  text,
  timestamp: Date.now(),
});

// ============================================================================
// useGameEngine Hook
// ============================================================================
function useGameEngine() {
  const [gameState, setGameState] = useState<GameState>(INITIAL_STATE);
  const [myPlayerId, setMyPlayerId] = useState('');
  const [myName, setMyName] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  
  const peerRef = useRef<Peer | null>(null);
  const connectionsRef = useRef<{ [key: string]: DataConnection }>({});
  const hostConnectionRef = useRef<DataConnection | null>(null);

  const isHost = gameState.players.find(p => p.id === myPlayerId)?.isHost || false;
  const role = gameState.godId === myPlayerId ? 'dios' : gameState.hitlerIds.includes(myPlayerId) ? 'hitler' : gameState.gandhiIds.includes(myPlayerId) ? 'gandhi' : 'espectador';

  const showError = useCallback((msg: string) => {
    setErrorMsg(msg);
    setTimeout(() => setErrorMsg(null), 5000);
  }, []);

  const broadcastState = useCallback((newState: GameState) => {
    Object.values(connectionsRef.current).forEach(conn => {
      if (conn.open) conn.send({ type: P2P_EVENTS.SYNC_STATE, payload: newState });
    });
  }, []);

  // --- RED: RECIBIR DATOS (HOST) ---
  const handleHostReceiveData = useCallback((conn: DataConnection, msg: any) => {
    setGameState(prev => {
      let newState = { ...prev };

      switch (msg.type) {
        case P2P_EVENTS.JOIN_REQUEST: {
          const { id, name } = msg.payload;
          if (newState.phase !== GamePhase.LOBBY) {
            conn.send({ type: P2P_EVENTS.ERROR, payload: 'Partida en curso.' });
            return prev;
          }
          connectionsRef.current[id] = conn;
          newState.players = [...newState.players, { id, name, score: 0, isHost: false }];
          newState.chat = [...newState.chat, systemMessage(`${name} entró a la sala.`)];
          break;
        }
        case P2P_EVENTS.CHAT_MESSAGE: {
          newState.chat = [...newState.chat, msg.payload];
          // Re-broadcastear mensaje de chat a todos los demás clientes
          Object.entries(connectionsRef.current).forEach(([clientId, clientConn]) => {
            if (clientId !== msg.payload.senderId && clientConn.open) {
              clientConn.send({ type: P2P_EVENTS.CHAT_MESSAGE, payload: msg.payload });
            }
          });
          break;
        }
        case P2P_EVENTS.CLIENT_ACTION:
          newState = gameReducer(newState, msg.payload);
          break;
      }
      
      setTimeout(() => broadcastState(newState), 0);
      return newState;
    });
  }, [broadcastState]);

  const initHost = (name: string) => {
    const hostId = uuidv4();
    const roomId = generateRoomCode();
    setMyPlayerId(hostId);
    setMyName(name);

    const peer = new Peer(roomId); 
    peerRef.current = peer;

    peer.on('open', (id) => {
      setGameState(prev => ({ ...prev, roomId: id, phase: GamePhase.LOBBY, players: [{ id: hostId, name, score: 0, isHost: true }] }));
    });

    peer.on('connection', (conn) => {
      conn.on('data', (data: any) => handleHostReceiveData(conn, data));
      conn.on('close', () => {
        setGameState(prev => {
          const leavingId = conn.metadata?.playerId;
          const leavingPlayer = prev.players.find(p => p.id === leavingId);
          const newState = {
            ...prev,
            players: prev.players.filter(p => p.id !== leavingId),
            chat: leavingPlayer ? [...prev.chat, systemMessage(`${leavingPlayer.name} salió de la sala.`)] : prev.chat
          };
          setTimeout(() => broadcastState(newState), 0);
          return newState;
        });
      });
    });

    peer.on('error', (err) => showError(`Error de red: ${err.message}`));
  };

  const joinRoom = (roomId: string, name: string) => {
    const clientId = uuidv4();
    setMyPlayerId(clientId);
    setMyName(name);

    const peer = new Peer(clientId);
    peerRef.current = peer;

    peer.on('open', () => {
      const conn = peer.connect(roomId.toUpperCase(), { metadata: { playerId: clientId, name } });
      hostConnectionRef.current = conn;

      conn.on('open', () => conn.send({ type: P2P_EVENTS.JOIN_REQUEST, payload: { id: clientId, name } }));
      
      conn.on('data', (msg: any) => {
        if (msg.type === P2P_EVENTS.SYNC_STATE) {
          setGameState(msg.payload);
        } else if (msg.type === P2P_EVENTS.CHAT_MESSAGE) {
          setGameState(prev => ({ ...prev, chat: [...prev.chat, msg.payload] }));
        } else if (msg.type === P2P_EVENTS.ERROR) {
          showError(msg.payload);
        }
      });

      conn.on('close', () => {
        showError("El Host finalizó la partida.");
        setGameState(INITIAL_STATE);
      });
    });

    peer.on('error', () => showError(`No se pudo conectar a la sala ${roomId}.`));
  };

  const sendAction = (action: any) => {
    if (isHost) {
      setGameState(prev => {
        const newState = gameReducer(prev, action);
        setTimeout(() => broadcastState(newState), 0);
        return newState;
      });
    } else if (hostConnectionRef.current) {
      hostConnectionRef.current.send({ type: P2P_EVENTS.CLIENT_ACTION, payload: action });
    }
  };

  const sendChatMessage = (text: string) => {
    if (!text.trim()) return;
    const msg: ChatMessage = { id: uuidv4(), senderId: myPlayerId, senderName: myName, text: text.trim(), timestamp: Date.now() };
    if (isHost) {
      setGameState(prev => {
        const newState = { ...prev, chat: [...prev.chat, msg] };
        setTimeout(() => broadcastState(newState), 0);
        return newState;
      });
    } else if (hostConnectionRef.current) {
      hostConnectionRef.current.send({ type: P2P_EVENTS.CHAT_MESSAGE, payload: msg });
    }
  };

  return {
    gameState, myPlayerId, myName, isHost, role, errorMsg,
    initHost, joinRoom, sendAction, sendChatMessage
  };
}

// ============================================================================
// gameReducer
// ============================================================================
function gameReducer(state: GameState, action: any): GameState {
  
  const getTopic = (s: GameState) => {
    let pool = DEFAULT_TOPICS;
    
    if (s.topicMode === TopicMode.CUSTOM && s.customTopics.length > 0) {
      pool = s.customTopics;
    } else if (s.topicMode === TopicMode.MIXED && s.customTopics.length > 0) {
      pool = [...DEFAULT_TOPICS, ...s.customTopics];
    }

    if (pool.length > 1 && s.topic) {
      const filteredPool = pool.filter(t => t !== s.topic);
      if (filteredPool.length > 0) pool = filteredPool;
    }

    return getRandomItem(pool);
  };

  const startRound = (s: GameState, roundNum: number): GameState => {
    const players = [...s.players];
    const currentGodIndex = players.findIndex(p => p.id === s.godId);
    let nextGodIndex = currentGodIndex >= 0 ? (currentGodIndex + 1) % players.length : 0;
    const godId = players[nextGodIndex].id;

    const remaining = players.filter(p => p.id !== godId).sort(() => Math.random() - 0.5);
    const half = Math.floor(remaining.length / 2);
    
    return {
      ...s,
      currentRound: roundNum,
      godId,
      hitlerIds: remaining.slice(0, half).map(p => p.id),
      gandhiIds: remaining.slice(half).map(p => p.id),
      topic: getTopic(s),
      criterion: getRandomItem(CRITERIA),
      phase: GamePhase.ROLES,
      roundWinner: null,
      debateEndTime: null
    };
  };

  switch (action.type) {
    case 'UPDATE_SETTINGS':
      return { ...state, ...action.payload };
    case 'START_GAME':
      return startRound({ ...state, players: state.players.map(p => ({ ...p, score: 0 })) }, 1);
    case 'NEXT_PHASE':
      const flow: any = {
        [GamePhase.ROLES]: GamePhase.TOPIC,
        [GamePhase.TOPIC]: GamePhase.DICE, 
        [GamePhase.DICE]: GamePhase.DEBATE,
        [GamePhase.DEBATE]: GamePhase.SENTENCE
      };
      const nextPhase = flow[state.phase] || state.phase;
      const endTime = nextPhase === GamePhase.DEBATE ? Date.now() + 60000 : null;
      return { ...state, phase: nextPhase, debateEndTime: endTime };
    case 'ROLL_DICE':
      const result = Math.floor(Math.random() * 6) + 1;
      const event = result > 4 ? "¡Hitler tiene el doble de tiempo!" : result < 3 ? "¡Gandhi puede interrumpir todo el rato!" : "Debate completamente normal.";
      return { ...state, chat: [...state.chat, { id: uuidv4(), senderName: 'Dios ⚡', text: `Tiró los dados y sacó: ${result} 🎲 - ${event}`, timestamp: Date.now() }] };
    case 'CAST_SENTENCE':
      const winner = action.payload.winner;
      const updatedPlayers = state.players.map(p => {
        if (winner === 'hitler' && state.hitlerIds.includes(p.id)) return { ...p, score: p.score + 1 };
        if (winner === 'gandhi' && state.gandhiIds.includes(p.id)) return { ...p, score: p.score + 1 };
        return p;
      });
      const gameWinner = updatedPlayers.find(p => p.score >= state.targetScore);
      return {
        ...state, roundWinner: winner, players: updatedPlayers,
        phase: gameWinner ? GamePhase.GAMEOVER : GamePhase.RESULTS,
        gameWinnerId: gameWinner ? gameWinner.id : null,
        debateEndTime: null
      };
    case 'NEXT_ROUND':
      return startRound(state, state.currentRound + 1);
    case 'RESTART_GAME':
      return { ...state, phase: GamePhase.LOBBY, currentRound: 1 };
    default:
      return state;
  }
}

// ============================================================================
// DebateTimer
// ============================================================================
const DebateTimer = ({ endTime, isHost, onTimeUp }: { endTime: number | null, isHost: boolean, onTimeUp: () => void }) => {
  const [timeLeft, setTimeLeft] = useState(60);

  useEffect(() => {
    if (!endTime) return;
    const interval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((endTime - Date.now()) / 1000));
      setTimeLeft(remaining);
      if (remaining === 0 && isHost) {
        clearInterval(interval);
        onTimeUp(); 
      }
    }, 500);
    return () => clearInterval(interval);
  }, [endTime, isHost, onTimeUp]);

  return (
    <div className="text-6xl font-black text-red-500 font-mono tracking-tighter w-32 text-center">
      {timeLeft}
    </div>
  );
};

// ============================================================================
// App Component
// ============================================================================
export default function App() {
  const { 
    gameState, myPlayerId, isHost, role, errorMsg, 
    initHost, joinRoom, sendAction, sendChatMessage 
  } = useGameEngine();

  const [roomInput, setRoomInput] = useState('');
  const [myNameInput, setMyNameInput] = useState('');
  const [customTopicsInput, setCustomTopicsInput] = useState('');
  const [chatText, setChatText] = useState('');
  
  const chatEndRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }), [gameState.chat]);

  useEffect(() => {
    if (gameState.phase === GamePhase.GAMEOVER) {
      confetti({
        particleCount: 200,
        spread: 90,
        origin: { x: 0.5, y: 0.6 },
      });
    }
  }, [gameState.phase]);

  const copyToClipboard = async (text: string) => {
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const el = document.createElement('textarea');
        el.value = text;
        document.body.appendChild(el);
        el.select();
        document.execCommand('copy');
        document.body.removeChild(el);
      }
      alert("¡Código copiado!");
    } catch (err) {
      console.error('Error al copiar:', err);
    }
  };

  // --- VISTA 1: MENU ---
  if (gameState.phase === GamePhase.MENU) {
    return (
      <div className="min-h-screen bg-slate-950 text-white flex flex-col items-center justify-center p-4">
        {errorMsg && <div className="absolute top-4 bg-red-600 text-white px-6 py-3 rounded-xl shadow-lg flex items-center gap-2"><AlertCircle/> {errorMsg}</div>}
        <div className="max-w-md w-full bg-slate-900/50 p-8 rounded-3xl border border-slate-800 shadow-2xl text-center">
          <h1 className="text-4xl font-black mb-2 bg-clip-text text-transparent bg-gradient-to-r from-yellow-400 via-red-500 to-indigo-500">DIOS, HITLER Y GANDHI</h1>
          <p className="text-slate-400 mb-8">Entran en un bar...</p>
          
          <input type="text" placeholder="Tu Nombre" value={myNameInput} onChange={e => setMyNameInput(e.target.value)} className="w-full bg-slate-800 rounded-xl px-4 py-4 mb-4 text-center text-xl focus:outline-none focus:ring-2 focus:ring-indigo-500"/>
          
          <div className="space-y-4">
            <button onClick={() => initHost(myNameInput)} disabled={!myNameInput.trim()} className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 py-4 rounded-xl font-bold text-lg shadow-lg flex justify-center items-center gap-2">
              <Crown/> Crear Sala
            </button>
            <div className="relative flex items-center py-2">
              <div className="flex-grow border-t border-slate-700"></div>
              <span className="flex-shrink-0 mx-4 text-slate-500">O unirse</span>
              <div className="flex-grow border-t border-slate-700"></div>
            </div>
            <input type="text" placeholder="Código de Sala" value={roomInput} onChange={e => setRoomInput(e.target.value.toUpperCase())} maxLength={6} className="w-full bg-slate-800 rounded-xl px-4 py-4 mb-2 text-center text-xl font-mono tracking-widest focus:outline-none focus:ring-2 focus:ring-emerald-500"/>
            <button onClick={() => joinRoom(roomInput, myNameInput)} disabled={!myNameInput.trim() || roomInput.length < 3} className="w-full bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 py-4 rounded-xl font-bold text-lg shadow-lg">
              Entrar
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --- ESTRUCTURA PRINCIPAL DEL JUEGO ---
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col">
      {errorMsg && <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 bg-red-600 text-white px-6 py-3 rounded-full font-bold shadow-xl flex items-center gap-2"><AlertCircle size={20} /> {errorMsg}</div>}
      
      <header className="bg-slate-900 border-b border-slate-800 p-4 flex justify-between items-center z-10">
        <div className="font-black text-indigo-400 hidden sm:block">DH&G</div>
        <div className="flex gap-4">
          <div className="bg-slate-800 px-4 py-1.5 rounded-full border border-slate-700 font-bold">Ronda {gameState.currentRound}</div>
          <div className="bg-yellow-500/10 text-yellow-400 border border-yellow-500/30 px-4 py-1.5 rounded-full font-bold">Meta: {gameState.targetScore} pts</div>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        <main className="flex-1 overflow-y-auto p-4 md:p-8 relative">
          
          {/* FASE: LOBBY */}
          {gameState.phase === GamePhase.LOBBY && (
            <div className="max-w-3xl mx-auto mt-8">
              <div className="bg-slate-800/80 p-8 rounded-3xl border border-slate-700 shadow-2xl text-center mb-8">
                <h2 className="text-2xl text-slate-400 mb-4">Código de Sala</h2>
                <div className="flex justify-center items-center gap-4">
                  <span className="text-6xl font-black font-mono text-indigo-400 tracking-widest">{gameState.roomId}</span>
                  <button onClick={() => copyToClipboard(gameState.roomId)} className="p-3 bg-slate-700 hover:bg-slate-600 rounded-xl transition-colors font-bold flex items-center gap-2">
                    <Copy/> Copiar
                  </button>
                </div>
              </div>

              {isHost && (
                <div className="bg-slate-800/50 p-6 rounded-2xl border border-slate-700 mb-8">
                  <h3 className="flex items-center gap-2 font-bold mb-4 text-indigo-300"><Settings/> Configuración</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Puntos para ganar:</label>
                      <input type="number" value={gameState.targetScore} onChange={e => sendAction({type: 'UPDATE_SETTINGS', payload: {targetScore: parseInt(e.target.value)||3}})} className="bg-slate-900 border border-slate-600 rounded px-3 py-1 w-24"/>
                    </div>
                    <div>
                      <label className="block text-sm text-slate-400 mb-1">Temas:</label>
                      <select value={gameState.topicMode} onChange={e => sendAction({type: 'UPDATE_SETTINGS', payload: {topicMode: e.target.value}})} className="bg-slate-900 border border-slate-600 rounded px-3 py-2 w-full mb-2">
                        <option value={TopicMode.DEFAULT}>Normales</option>
                        <option value={TopicMode.CUSTOM}>Solo Personalizados</option>
                        <option value={TopicMode.MIXED}>Mezclados</option>
                      </select>
                      {(gameState.topicMode === TopicMode.CUSTOM || gameState.topicMode === TopicMode.MIXED) && (
                        <textarea 
                          placeholder="Ej: Mi jefe, El clima, Perros (Sepáralos usando Enter o comas)" 
                          value={customTopicsInput} 
                          onChange={e => {
                            setCustomTopicsInput(e.target.value);
                            const parsedTopics = e.target.value.split(/[,;\n]+/).map(s=>s.trim()).filter(s=>s.length > 0);
                            sendAction({type: 'UPDATE_SETTINGS', payload: {customTopics: parsedTopics}});
                          }} 
                          className="w-full bg-slate-900 border border-slate-600 rounded p-3 h-24 mt-2"
                        />
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-8">
                {gameState.players.map(p => (
                  <div key={p.id} className="bg-slate-800 p-4 rounded-xl flex items-center gap-3 border border-slate-700">
                    <div className="w-10 h-10 bg-indigo-600 rounded-full flex items-center justify-center font-bold">{p.name.charAt(0)}</div>
                    <div className="truncate flex-1">
                      <div className="font-bold truncate">{p.name}</div>
                      {p.isHost && <div className="text-xs text-yellow-400 flex items-center gap-1"><Crown size={12}/> Host</div>}
                    </div>
                  </div>
                ))}
              </div>

              {isHost ? (
                <button onClick={() => sendAction({type: 'START_GAME'})} disabled={gameState.players.length < 3} className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 py-4 rounded-xl font-bold text-xl shadow-lg">
                  {gameState.players.length < 3 ? 'Esperando jugadores (Mín. 3)' : '¡Empezar!'}
                </button>
              ) : (
                <div className="text-center p-6 bg-slate-900 rounded-xl text-slate-400 animate-pulse">Esperando al Host...</div>
              )}
            </div>
          )}

          {/* FASE: ROLES (DIOS CONTROLA EL BOTÓN) */}
          {gameState.phase === GamePhase.ROLES && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <h2 className="text-2xl text-slate-400 mb-8 uppercase tracking-widest">Tú eres...</h2>
              <div className={`p-16 rounded-full border-8 mb-12 shadow-[0_0_80px_rgba(0,0,0,0.5)] ${role === 'dios' ? 'border-yellow-400 bg-yellow-500/20 text-yellow-400' : role === 'hitler' ? 'border-red-500 bg-red-500/20 text-red-500' : role === 'gandhi' ? 'border-emerald-500 bg-emerald-500/20 text-emerald-500' : 'border-slate-500 bg-slate-500/20 text-slate-400'}`}>
                <h1 className="text-7xl font-black mb-4 uppercase">{role}</h1>
              </div>
              {role === 'dios' ? (
                <button onClick={() => sendAction({type: 'NEXT_PHASE'})} className="bg-yellow-500 text-slate-900 px-8 py-4 rounded-xl font-black text-xl hover:bg-yellow-400 shadow-lg shadow-yellow-500/30">
                  Dios Manda: Revelar Tema
                </button>
              ) : (
                <p className="text-slate-500 italic mt-8">Esperando a que Dios revele el tema...</p>
              )}
            </div>
          )}

          {/* FASE: TOPIC (DIOS CONTROLA EL BOTÓN) */}
          {gameState.phase === GamePhase.TOPIC && (
            <div className="flex flex-col items-center justify-center h-full text-center max-w-4xl mx-auto">
              <div className="text-slate-400 mb-4 uppercase font-bold">El tema es:</div>
              <h1 className="text-5xl md:text-7xl font-black text-white mb-12 bg-slate-900 p-8 rounded-3xl border border-slate-700">"{gameState.topic}"</h1>
              <div className="bg-indigo-900/40 p-8 rounded-2xl mb-12 w-full">
                <div className="text-indigo-300 font-bold uppercase mb-2">Criterio Divino para ganar</div>
                <h3 className="text-3xl font-black text-white mb-2">{gameState.criterion?.name}</h3>
              </div>
              {role === 'dios' ? (
                <button onClick={() => sendAction({type: 'NEXT_PHASE'})} className="bg-yellow-500 text-slate-900 px-12 py-4 rounded-xl font-black text-2xl hover:bg-yellow-400 shadow-lg shadow-yellow-500/30">
                  Lanzar Dados 🎲
                </button>
              ) : (
                <p className="text-slate-500 italic">Esperando a que Dios tire los dados...</p>
              )}
            </div>
          )}

          {/* FASE: DICE (DIOS CONTROLA LOS BOTONES) */}
          {gameState.phase === GamePhase.DICE && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Dices className="w-32 h-32 text-indigo-400 mb-8" />
              <h2 className="text-4xl font-black mb-8">Eventos del Destino</h2>
              {role === 'dios' ? (
                <div className="flex gap-4">
                  <button onClick={() => sendAction({type: 'ROLL_DICE'})} className="bg-purple-600 px-8 py-4 rounded-xl font-bold text-xl hover:bg-purple-500 shadow-lg shadow-purple-500/30">
                    Tirar Dado
                  </button>
                  <button onClick={() => sendAction({type: 'NEXT_PHASE'})} className="bg-yellow-500 text-slate-900 px-8 py-4 rounded-xl font-black text-xl hover:bg-yellow-400 shadow-lg shadow-yellow-500/30">
                    Iniciar Debate ⚔️
                  </button>
                </div>
              ) : (
                <p className="text-slate-500 italic">Dios está jugando con el destino... Revisa el chat para ver qué sale.</p>
              )}
            </div>
          )}

          {/* FASE: DEBATE (DIOS PUEDE DETENERLO) */}
          {gameState.phase === GamePhase.DEBATE && (
            <div className="flex flex-col h-full max-w-5xl mx-auto">
              <div className="flex justify-between items-center bg-slate-800 p-6 rounded-2xl mb-8">
                <div className="flex-1"><div className="text-xl font-bold">{gameState.topic}</div></div>
                <DebateTimer endTime={gameState.debateEndTime} isHost={isHost} onTimeUp={() => sendAction({type: 'NEXT_PHASE'})} />
                <div className="flex-1 text-right"><div className="text-xl font-bold text-indigo-400">{gameState.criterion?.name}</div></div>
              </div>
              <div className="flex-1 grid grid-cols-2 gap-8">
                <div className={`bg-red-900/20 border-2 ${role==='hitler'?'border-red-500':'border-red-900/50'} rounded-3xl flex items-center justify-center flex-col`}><h2 className="text-4xl font-black text-red-500">HITLERS 👿</h2></div>
                <div className={`bg-emerald-900/20 border-2 ${role==='gandhi'?'border-emerald-500':'border-emerald-900/50'} rounded-3xl flex items-center justify-center flex-col`}><h2 className="text-4xl font-black text-emerald-500">GANDHIS 🕊️</h2></div>
              </div>
              {role === 'dios' && (
                <button onClick={() => sendAction({type: 'NEXT_PHASE'})} className="mt-8 bg-red-600 hover:bg-red-500 px-8 py-3 rounded-xl mx-auto block font-bold text-white shadow-lg shadow-red-500/30">
                  ¡Suficiente! Detener Debate Ahora
                </button>
              )}
            </div>
          )}

          {/* FASE: SENTENCE (SOLO DIOS VOTA) */}
          {gameState.phase === GamePhase.SENTENCE && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Crown className="w-24 h-24 text-yellow-500 mb-8" />
              <h2 className="text-5xl font-black mb-4">El Veredicto de Dios</h2>
              {role === 'dios' ? (
                <div className="flex gap-6 mt-8">
                  <button onClick={() => sendAction({type: 'CAST_SENTENCE', payload: {winner: 'hitler'}})} className="bg-red-600 px-12 py-8 rounded-3xl text-3xl font-black hover:bg-red-500 shadow-lg shadow-red-500/30">Hitler Gana 👿</button>
                  <button onClick={() => sendAction({type: 'CAST_SENTENCE', payload: {winner: 'gandhi'}})} className="bg-emerald-600 px-12 py-8 rounded-3xl text-3xl font-black hover:bg-emerald-500 shadow-lg shadow-emerald-500/30">Gandhi Gana 🕊️</button>
                </div>
              ) : (<div className="bg-slate-900 p-8 rounded-2xl animate-pulse text-xl mt-8">Dios está meditando su respuesta... Shh.</div>)}
            </div>
          )}

          {/* FASE: RESULTS (DIOS DECIDE PASAR A LA SIGUIENTE) */}
          {gameState.phase === GamePhase.RESULTS && (
             <div className="flex flex-col items-center justify-center h-full text-center">
                <div className={`text-9xl font-black mb-12 ${gameState.roundWinner === 'hitler' ? 'text-red-500' : 'text-emerald-500'}`}>{gameState.roundWinner === 'hitler' ? 'HITLER 👿' : 'GANDHI 🕊️'}</div>
                {role === 'dios' ? (
                  <button onClick={() => sendAction({type: 'NEXT_ROUND'})} className="bg-yellow-500 text-slate-900 px-12 py-4 rounded-xl font-black text-xl hover:bg-yellow-400 shadow-lg shadow-yellow-500/30">
                    Siguiente Ronda
                  </button>
                ) : (
                  <p className="text-slate-500 italic">Esperando que Dios pase de ronda...</p>
                )}
             </div>
          )}
          
          {/* FASE: GAMEOVER (HOST DECIDE REINICIAR LA SALA) */}
          {gameState.phase === GamePhase.GAMEOVER && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <Trophy className="w-32 h-32 text-yellow-400 mb-8" />
              <h1 className="text-5xl font-black mb-4">FIN DEL JUEGO</h1>
              <div className="text-7xl font-black text-amber-500 mb-12">{gameState.players.find(p => p.id === gameState.gameWinnerId)?.name} 👑</div>
              {isHost ? (
                <button onClick={() => sendAction({type: 'RESTART_GAME'})} className="bg-indigo-600 px-12 py-4 rounded-xl font-bold text-xl hover:bg-indigo-500">Volver al Lobby de Espera</button>
              ) : (
                <p className="text-slate-500 italic">El Host está configurando la siguiente partida...</p>
              )}
            </div>
          )}
        </main>
        
        {/* PANEL LATERAL: CHAT DE TEXTO LIMPIO */}
        <aside className="w-80 bg-slate-900/50 border-l border-slate-800 p-4 hidden lg:flex flex-col">
          <div className="flex flex-col h-full bg-slate-900 rounded-2xl border border-slate-700 overflow-hidden shadow-2xl">
            <div className="bg-slate-800 p-4 border-b border-slate-700 font-bold flex gap-2 items-center"><MessageSquare size={18}/> Registro de Eventos</div>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {gameState.chat.map((msg) => (
                <div key={msg.id} className={`flex flex-col ${msg.senderName === 'Dios ⚡' ? 'items-center' : msg.senderId === myPlayerId ? 'items-end' : 'items-start'}`}>
                  {msg.senderName !== 'Dios ⚡' && <span className="text-xs text-slate-400 mb-1 font-bold">{msg.senderName}</span>}
                  <div className={`px-4 py-2 rounded-xl text-sm ${msg.senderName === 'Dios ⚡' ? 'bg-yellow-500/20 text-yellow-300 w-full text-center border border-yellow-500/30' : msg.senderId === myPlayerId ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'bg-slate-700 shadow-md'}`}>
                    {msg.text}
                  </div>
                </div>
              ))}
              <div ref={chatEndRef} />
            </div>
            <div className="p-3 bg-slate-800 flex gap-2">
              <input type="text" value={chatText} onChange={e => setChatText(e.target.value)} onKeyDown={e => e.key === 'Enter' && (sendChatMessage(chatText), setChatText(''))} className="flex-1 bg-slate-900 rounded-lg p-3 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 border border-slate-700" placeholder="Escribe al chat..." />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
