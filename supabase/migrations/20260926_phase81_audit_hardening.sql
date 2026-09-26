-- Phase 81 — Supabase-Haertung aus dem Gesamtaudit 2026-09-26
--
-- Zwei Befunde des Audits, beide von den Supabase-Advisors gemeldet:
--
--   Befund 8  (Lint 0028_anon_security_definer_function_executable)
--             Sechs SECURITY-DEFINER-Funktionen waren fuer die Rolle `anon`
--             ausfuehrbar. Die Review-RPCs sind reines Dashboard-/Reviewer-
--             Tooling und werden im Repo nirgends aufgerufen;
--             `submit_manga_catalog_candidate` ruft zwar der Client auf, aber
--             ausschliesslich mit frischem Session-Token
--             (src/supabase.js:341 -> ensureFreshAccessToken(), ohne Token
--             wird 'blocked' zurueckgegeben). Die Rolle ist dort also immer
--             `authenticated`, nie `anon`.
--             Phase 51e hatte `submit_release_intake_candidate` bereits
--             entsprechend gehaertet — `submit_manga_catalog_candidate` wurde
--             damals uebersehen. Diese Migration zieht das nach.
--
--   Befund 20 (Lint 0003_auth_rls_initplan)
--             Die beiden Owner-Policies auf public.collections werteten
--             auth.uid() pro Zeile aus. Mit (select auth.uid()) wertet
--             Postgres den Aufruf einmal pro Query als InitPlan aus.
--             Rein nicht-funktionale Aenderung: die Praedikatslogik bleibt
--             identisch.
--
-- Bewusst NICHT geaendert:
--   Lint 0006_multiple_permissive_policies auf public.collections. Die beiden
--   SELECT-Policies (Owner-Zugriff und oeffentliche Projektion) haben
--   unterschiedliche Semantik; sie zu einer Policy zusammenzuziehen waere eine
--   Verhaltensaenderung am Sharing-Pfad fuer einen Performancegewinn, der bei
--   der aktuellen Zeilenzahl nicht messbar ist.

begin;

-- ── Befund 8: EXECUTE fuer anon entziehen ───────────────────────────────────
-- Die Funktionen bleiben fuer `authenticated` erreichbar. Zusaetzlich greift
-- bei den Review-RPCs weiterhin tg_manga_catalog_resolve_reviewer(), das einen
-- gueltigen x-reviewer-token gegen public.manga_catalog_reviewers prueft.
--
-- WICHTIG — warum FROM public und nicht nur FROM anon:
-- Postgres vergibt EXECUTE auf neue Funktionen per Default an PUBLIC. In der
-- ACL steht das als fuehrendes "=X/postgres". `anon` haelt das Recht also gar
-- nicht direkt, sondern erbt es ueber PUBLIC — `revoke ... from anon` ist
-- deshalb wirkungslos (nachgemessen: has_function_privilege blieb true).
-- Genau darum hat Phase 51e nur bei submit_release_intake_candidate gewirkt:
-- dort fehlt der PUBLIC-Eintrag, bei den uebrigen Funktionen ist er noch da.
-- Korrekt ist deshalb: erst PUBLIC entziehen, dann gezielt zurueckgeben.

revoke execute on function public.review_candidate_start(text) from public, anon;
grant  execute on function public.review_candidate_start(text) to authenticated, service_role;

revoke execute on function public.review_candidate_approve(text, smallint, text) from public, anon;
grant  execute on function public.review_candidate_approve(text, smallint, text) to authenticated, service_role;

revoke execute on function public.review_candidate_reject(text, text) from public, anon;
grant  execute on function public.review_candidate_reject(text, text) to authenticated, service_role;

revoke execute on function public.review_candidate_block(text, text) from public, anon;
grant  execute on function public.review_candidate_block(text, text) to authenticated, service_role;

revoke execute on function public.review_candidate_mark_duplicate(text, uuid, text) from public, anon;
grant  execute on function public.review_candidate_mark_duplicate(text, uuid, text) to authenticated, service_role;

revoke execute on function public.submit_manga_catalog_candidate(
  text, text, integer, text, text, date, text, text, text, jsonb
) from public, anon;
grant  execute on function public.submit_manga_catalog_candidate(
  text, text, integer, text, text, date, text, text, text, jsonb
) to authenticated, service_role;

-- ── Befund 20: auth.uid() als InitPlan auswerten ────────────────────────────

alter policy collections_select_owner on public.collections
  using ((user_id is not null) and (user_id = (select auth.uid())));

alter policy collections_update_owner on public.collections
  using ((user_id is not null) and (user_id = (select auth.uid())))
  with check ((user_id is not null) and (user_id = (select auth.uid())));

commit;
