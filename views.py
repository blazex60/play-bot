from __future__ import annotations

from typing import Any, Callable, Coroutine

import discord


class SearchResultView(discord.ui.View):
    """Presents up to 5 YouTube search results as a select menu."""

    def __init__(
        self,
        results: list[dict[str, Any]],
        on_select: Callable[[dict[str, Any]], Coroutine[Any, Any, None]],
        timeout: float = 30.0,
    ) -> None:
        super().__init__(timeout=timeout)
        self._results = results
        self._on_select = on_select

        options = [
            discord.SelectOption(
                label=self._truncate(entry.get("title") or "Unknown", 100),
                description=self._format_duration(entry.get("duration")),
                value=str(i),
            )
            for i, entry in enumerate(results[:5])
        ]

        select = discord.ui.Select(
            placeholder="再生する曲を選んでください",
            min_values=1,
            max_values=1,
            options=options,
        )
        select.callback = self._select_callback  # type: ignore[method-assign]
        self.add_item(select)

    # ------------------------------------------------------------------
    # Callbacks
    # ------------------------------------------------------------------

    async def _select_callback(self, interaction: discord.Interaction) -> None:
        await interaction.response.defer()
        idx = int(interaction.data["values"][0])  # type: ignore[index]
        selected = self._results[idx]
        self.stop()
        await self._on_select(selected)

    async def on_timeout(self) -> None:
        self.stop()

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _truncate(text: str, max_len: int) -> str:
        return text if len(text) <= max_len else text[: max_len - 1] + "…"

    @staticmethod
    def _format_duration(duration: int | float | None) -> str:
        if duration is None:
            return ""
        secs = int(duration)
        minutes, seconds = divmod(secs, 60)
        hours, minutes = divmod(minutes, 60)
        if hours:
            return f"{hours}:{minutes:02d}:{seconds:02d}"
        return f"{minutes}:{seconds:02d}"
