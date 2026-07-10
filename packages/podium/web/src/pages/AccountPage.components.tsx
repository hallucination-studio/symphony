import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthUser } from "../api/types";
import { api } from "../api/client";
import { Card } from "../components/Card";
import { Button } from "../components/Button";
import { DetailList } from "../components/Drawer";
import { useToast } from "../components/Toast";
import { useI18n } from "../i18n";

export function IdentityCard({ user }: { user: AuthUser }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notify } = useToast();
  const { t } = useI18n();
  const [loggingOut, setLoggingOut] = useState(false);

  async function logout() {
    setLoggingOut(true);
    try {
      await api.logout();
      queryClient.clear();
      navigate("/login");
    } catch {
      notify(t("Couldn't sign out. Try again."), "error");
      setLoggingOut(false);
    }
  }

  return (
    <Card
      title={t("Account")}
      description={t("Your personal workspace identity.")}
      actions={<Button variant="secondary" onClick={logout} loading={loggingOut}>{t("Log out")}</Button>}
    >
      <DetailList rows={[
        { key: t("Email"), value: <span>{user.email}</span> },
        { key: t("Workspace"), value: <code className="code">{user.id}</code> },
      ]} />
    </Card>
  );
}
