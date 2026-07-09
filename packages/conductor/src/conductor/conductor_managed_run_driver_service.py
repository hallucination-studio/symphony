from __future__ import annotations

from typing import Any

from .conductor_managed_run_driver import ConductorManagedRunDriver


async def drive_managed_run_runs_once(service: Any) -> dict[str, int]:
    driver = ConductorManagedRunDriver(
        store=service.managed_run_store,
        coordinator=service.managed_run_coordinator,
        runtime_manager=service.runtime_manager,
        instance_lookup=service.store.get_instance,
        instance_update=service.store.update_instance,
        runtime_config=service._managed_run_runtime_config,
    )
    return await driver.drive_once()


__all__ = ["drive_managed_run_runs_once"]
