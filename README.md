# 🦎 Chameleon

A pass-free, one-phone-per-player version of the Chameleon party game. Everyone gets the secret word except the Chameleon.

## How phones stay in sync (no server)
- Everyone enters the same **room code**, **player count** and **category**, and picks their own **player number** (clockwise around the circle).
- The word, the Chameleon and the first clue-giver are derived from a seeded random generator, so every phone computes the same result offline.
- A **sync check** name (e.g. "Teal Gecko") is shown each round — every phone should match.
- The **timer** starts on the next 5‑second boundary of the phone's clock, so phones that tap Start together count down in lockstep.

## Run it
Static single file — open `index.html`, or enable GitHub Pages (Settings → Pages → Deploy from branch → `main` / root).
