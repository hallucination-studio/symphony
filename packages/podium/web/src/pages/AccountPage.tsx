import { useMe } from "../auth/useSession";
import { PageHeader, QueryState } from "../components/PageState";
import { useI18n } from "../i18n";
import { IdentityCard } from "./AccountPage.components";

export default function AccountPage() {
  const me = useMe();
  const { t } = useI18n();

  return (
    <>
      <PageHeader
        title={t("Account")}
        description={t("Your workspace identity.")}
      />
      <QueryState isLoading={me.isLoading} error={null}>
        {me.user ? <IdentityCard user={me.user} /> : null}
      </QueryState>
    </>
  );
}
