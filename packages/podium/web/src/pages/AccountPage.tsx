import { useBootstrap } from "../api/hooks";
import { useMe } from "../auth/useSession";
import { PageHeader, QueryState } from "../components/PageState";
import { useI18n } from "../i18n";
import {
  IdentityCard,
  LinearApplicationCard,
  ServicesCards,
} from "./AccountPage.components";

export default function AccountPage() {
  const me = useMe();
  const bootstrap = useBootstrap();
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t("Account")}
        description={t("Your workspace identity and connected services.")}
      />
      <QueryState isLoading={me.isLoading} error={null}>
        {me.user ? <IdentityCard user={me.user} /> : null}
      </QueryState>
      <div className="page-stack">
        <LinearApplicationCard initial={me.user?.linear_app ?? null} />
      </div>
      <QueryState isLoading={bootstrap.isLoading} error={bootstrap.error}>
        {bootstrap.data ? <ServicesCards data={bootstrap.data} /> : null}
      </QueryState>
    </>
  );
}
