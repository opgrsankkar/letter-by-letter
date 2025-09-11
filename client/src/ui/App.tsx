import React, { useState } from 'react';
import { useGameSocket } from './useGameSocket';

export const App: React.FC = () => {
    const [name, setName] = useState('');
    const [roomCodeInput, setRoomCodeInput] = useState('');
    const [word, setWord] = useState('');
    const { room, letters, connectCreate, connectJoin, startRound, submitWord, isHost, messages, dismissMessage, hostWord } =
        useGameSocket();

    return (
        <div className="max-w-md mx-auto p-4 space-y-4 relative">
            <h1 className="text-2xl font-bold text-center">Letter by Letter</h1>
            {!room && (
                <div className="space-y-3">
                    <input
                        className="w-full px-3 py-2 rounded bg-slate-800"
                        placeholder="Your name"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                    />
                    <div className="flex gap-2">
                        <button
                            disabled={!name}
                            className="flex-1 bg-indigo-600 disabled:opacity-40 rounded py-2"
                            onClick={() => connectCreate(name)}
                        >
                            Create Room
                        </button>
                    </div>
                    <div className="flex gap-2">
                        <input
                            className="flex-1 px-3 py-2 rounded bg-slate-800"
                            placeholder="Room Code"
                            value={roomCodeInput}
                            onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                        />
                        <button
                            disabled={!name || roomCodeInput.length < 4}
                            className="bg-teal-600 px-4 rounded"
                            onClick={() => connectJoin(roomCodeInput, name)}
                        >
                            Join
                        </button>
                    </div>
                </div>
            )}

            {room && (
                <div className="space-y-4">
                    <div className="flex justify-between items-center text-sm">
                        <span className="font-mono text-slate-300">Room: {room.id}</span>
                        <span>Round: {room.round}</span>
                    </div>
                    <div>
                        <h2 className="font-semibold">Players</h2>
                        <ul className="text-sm space-y-1">
                            {room.players.map((p) => (
                                <li key={p.id} className={p.id === room.hostId ? 'text-amber-400' : ''}>
                                    {p.name}
                                    {p.id === room.hostId && ' (Host)'}
                                </li>
                            ))}
                        </ul>
                    </div>

                    {room.state === 'waiting' && (
                        <button className="w-full bg-indigo-600 rounded py-2" onClick={() => startRound()}>
                            Start Round
                        </button>
                    )}

                    {isHost && (
                        <div className="space-y-3">
                            {!hostWord && room.state === 'in-round' && (
                                <div className="space-y-2">
                                    <h3 className="font-semibold">Enter Secret Word</h3>
                                    <input
                                        className="w-full px-3 py-2 rounded bg-slate-800"
                                        value={word}
                                        onChange={(e) => setWord(e.target.value)}
                                    />
                                    <button
                                        disabled={!word.trim()}
                                        className="w-full bg-emerald-600 rounded py-2 disabled:opacity-40"
                                        onClick={() => {
                                            submitWord(word);
                                            setWord('');
                                        }}
                                    >
                                        Submit
                                    </button>
                                </div>
                            )}
                            {hostWord && (
                                <div className="p-3 rounded bg-slate-800 border border-slate-700">
                                    <h3 className="font-semibold mb-1">Current Word</h3>
                                    <div className="tracking-wide text-lg font-mono">{hostWord.toLocaleUpperCase()}</div>
                                    <div className="text-xs text-slate-400 mt-1">Visible only to you.</div>
                                </div>
                            )}
                        </div>
                    )}

                    {letters.length > 0 && !isHost && (
                        <div>
                            <h3 className="font-semibold">Your Letters</h3>
                            <div className="flex flex-wrap gap-2">
                                {letters.map((l: string, i: number) => (
                                    <span key={i} className="text-xl font-bold inline-block bg-slate-800 rounded px-3 py-2">
                                        {l}
                                    </span>
                                ))}
                            </div>
                        </div>
                    )}

                    {room.state === 'in-round' && !isHost && letters.length === 0 && (
                        <div className="italic text-sm text-slate-400">Waiting for host word...</div>
                    )}
                </div>
            )}
            {/* Toasts */}
            <div className="fixed inset-x-0 top-2 flex flex-col items-center gap-2 pointer-events-none z-50">
                {messages.map((m: { id: string; text: string }) => (
                    <div
                        key={m.id}
                        className="bg-red-600/90 text-white px-4 py-2 rounded shadow text-sm flex items-start gap-3 w-[90%] max-w-sm pointer-events-auto"
                    >
                        <span className="flex-1">{m.text}</span>
                        <button
                            onClick={() => dismissMessage(m.id)}
                            className="text-white/80 hover:text-white font-bold"
                            aria-label="Dismiss"
                        >
                            ×
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};
