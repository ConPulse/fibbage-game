# Fibbage Clone - Game Spec

## Overview
A Fibbage-style party trivia game. One TV/computer shows the main game screen. Players join via phone browser by entering a room code and their name. No app download needed.

## Tech Stack
- **Server:** Node.js + `ws` (WebSocket library) + `express` for static serving
- **Frontend:** Pure HTML/CSS/JS (no frameworks)
- **No database needed** — questions stored in a JSON file

## Architecture
```
TV Browser (Host) ←→ WebSocket Server ←→ Phone Browsers (Players)
```

- Server generates a 4-letter room code
- TV opens the host page, shows the room code
- Players go to the same URL on their phone, enter the code + their name
- Server manages all game state, timers, scoring
- TV is display-only (no input needed after starting)
- Phone shows contextual UI: text input for lies, buttons for answer selection

## Game Flow

### Lobby
- Host screen shows room code (big, easy to read from couch)
- As players join (2-8), their names appear on TV
- Host clicks "Start Game" on TV (or any player can trigger it)

### Round Structure (3 rounds)
- **Round 1:** 3 questions, base scoring
- **Round 2:** 3 questions, double scoring  
- **Final Fibbage:** 1 question, triple scoring

### Each Question Flow:
1. **Category Selection** (5 seconds) — A random player picks from 3 categories on their phone. If they don't pick, random selection.
2. **Question Display** (3 seconds) — TV shows the trivia fact with a blank ___
3. **Lie Phase** (45 seconds) — Each player types a fake answer on their phone. Countdown timer on TV. If someone doesn't submit, auto-generate a generic lie.
4. **Voting Phase** (30 seconds) — TV shows all lies + truth shuffled randomly. Each player picks which they think is true on their phone.
5. **Reveal Phase** (auto-paced) — TV reveals one by one: who picked what, who got fooled, then the truth. Show points earned per player.
6. **Scoreboard** (5 seconds) — Updated leaderboard on TV

### Scoring
- Find the truth: 1000 pts (×1 R1, ×2 R2, ×3 Final)
- Fool someone with your lie: 500 pts per person fooled (×1, ×2, ×3)
- Auto-generated lie: half points if it fools someone
- If your lie is too similar to the truth: reject it, ask for another

### End Game
- Final scoreboard with rankings
- Winner celebration animation
- "Play Again" button

## Question Database Format (questions.json)
```json
[
  {
    "id": 1,
    "category": "Florida Man",
    "question": "In 2019, a Florida man was arrested for throwing a ____ at a Wendy's employee.",
    "answer": "alligator",
    "alternateAnswers": ["gator", "an alligator"]
  },
  {
    "id": 2, 
    "category": "World Records",
    "question": "The world record for most ____ eaten in one minute is 72.",
    "answer": "grapes",
    "alternateAnswers": []
  }
]
```

Include at least 50 questions across these categories:
- Florida Man
- World Records  
- Weird Laws
- Food & Drink
- Science & Nature
- History
- Celebrity
- Sports
- Animals
- Technology

## UI Design

### TV/Host Screen
- Dark background (#1a1a2e navy), vibrant accent colors
- Large text readable from 10+ feet away
- Smooth transitions between phases
- Room code always visible in corner
- Player avatars/colors assigned on join
- Animated score reveals
- Timer bar that depletes visually

### Phone/Player Screen
- Mobile-first, thumb-friendly
- Large text input for typing lies
- Big tap targets for selecting answers
- Shows "Waiting..." when it's not your turn
- Vibrate on important events (your turn, times up)
- Player's current score visible

### Color Palette
- Background: #1a1a2e (dark navy)
- Primary: #e94560 (red)
- Accent: #4ecdc4 (teal)  
- Success: #2ecc71 (green)
- Warning: #f39c12 (gold)
- Text: #ffffff

## File Structure
```
/server.js          — Node.js server (express + ws)
/public/
  /index.html       — Landing page (enter room code or create game)
  /host.html         — TV/Host display
  /player.html       — Phone controller
  /css/style.css     — Shared styles
  /js/host.js        — Host screen logic
  /js/player.js      — Player phone logic
  /js/shared.js      — Shared constants
/questions.json      — Question database
/package.json
```

## Key Rules
1. All game logic lives on the server — clients are dumb
2. Fuzzy match player lies against truth (reject if too similar)
3. Timer is server-authoritative (no client-side cheating)
4. Handle disconnects gracefully (player can rejoin by name)
5. Works on any modern mobile browser
6. No authentication needed — just room code + name

## MVP Priority
Build it working first, make it pretty second. But the TV screen should look good enough to play at a party — dark theme, readable text, basic animations.
