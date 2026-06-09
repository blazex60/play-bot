from __future__ import annotations

import random
from dataclasses import dataclass, field
from enum import Enum, auto


class LoopMode(Enum):
    OFF = auto()
    TRACK = auto()
    QUEUE = auto()


@dataclass
class Track:
    webpage_url: str
    title: str
    duration: int | None  # seconds; None if unknown
    thumbnail: str | None
    requested_by: str  # display name of the requester


@dataclass
class GuildQueue:
    _tracks: list[Track] = field(default_factory=list)
    _pos: int = 0
    loop_mode: LoopMode = LoopMode.OFF

    # ------------------------------------------------------------------
    # Properties
    # ------------------------------------------------------------------

    @property
    def current(self) -> Track | None:
        if 0 <= self._pos < len(self._tracks):
            return self._tracks[self._pos]
        return None

    @property
    def is_empty(self) -> bool:
        return len(self._tracks) == 0

    # ------------------------------------------------------------------
    # Mutations
    # ------------------------------------------------------------------

    def add(self, track: Track) -> None:
        self._tracks.append(track)

    def clear(self) -> None:
        self._tracks.clear()
        self._pos = 0

    def shuffle(self) -> None:
        """Shuffle the queue while keeping the currently playing track first."""
        if len(self._tracks) <= 1:
            return
        current = self.current
        rest = [t for i, t in enumerate(self._tracks) if i != self._pos]
        random.shuffle(rest)
        if current is not None:
            self._tracks = [current] + rest
        else:
            self._tracks = rest
        self._pos = 0

    def cycle_loop(self) -> LoopMode:
        """Cycle through OFF -> TRACK -> QUEUE -> OFF and return new mode."""
        order = [LoopMode.OFF, LoopMode.TRACK, LoopMode.QUEUE]
        idx = order.index(self.loop_mode)
        self.loop_mode = order[(idx + 1) % len(order)]
        return self.loop_mode

    def next(self, force_advance: bool = False) -> Track | None:
        """Advance position and return the next track to play.

        Args:
            force_advance: When True, always move to the next track even if
                           loop mode is TRACK. Used by /skip.

        Returns:
            The next Track to play, or None if the queue is exhausted.
        """
        if self.is_empty:
            return None

        if self.loop_mode == LoopMode.TRACK and not force_advance:
            # Replay current track
            return self.current

        self._pos += 1

        if self._pos < len(self._tracks):
            return self._tracks[self._pos]

        # End of list
        if self.loop_mode == LoopMode.QUEUE:
            self._pos = 0
            return self._tracks[self._pos] if self._tracks else None

        # LoopMode.OFF (or TRACK with force_advance exhausted the list)
        self._pos = len(self._tracks)  # one-past-end sentinel
        return None

    # ------------------------------------------------------------------
    # Inspection helpers
    # ------------------------------------------------------------------

    def upcoming(self) -> list[Track]:
        """Return tracks after the current position."""
        return self._tracks[self._pos + 1 :]

    def all_tracks(self) -> list[Track]:
        return list(self._tracks)
