from __future__ import annotations


class PgLinearCutoverMixin:
    async def switch_workspace_installation(
        self,
        user_id: str,
        installation_id: str,
        app_user_id: str,
    ) -> None:
        async with self.pool.acquire() as connection:
            async with connection.transaction():
                await connection.execute(
                    """
                    UPDATE linear_workspace_installations
                    SET active = FALSE, state = 'retired', updated_at = now()
                    WHERE user_id = $1 AND active = TRUE
                    """,
                    user_id,
                )
                await connection.execute(
                    """
                    UPDATE linear_workspace_installations
                    SET active = TRUE, state = 'ready', action_required = '', next_action = '', updated_at = now()
                    WHERE user_id = $1 AND id = $2
                    """,
                    user_id,
                    installation_id,
                )
                await connection.execute(
                    """
                    UPDATE project_bindings
                    SET installation_id = $2,
                        agent_app_user_id = $3,
                        config_version = candidate_config_version,
                        state = 'switching',
                        candidate_installation_id = '',
                        candidate_agent_app_user_id = '',
                        candidate_config_version = 0,
                        candidate_acknowledged_config_version = 0,
                        updated_at = now()
                    WHERE user_id = $1 AND active = TRUE
                    """,
                    user_id,
                    installation_id,
                    app_user_id,
                )
