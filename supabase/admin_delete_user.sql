-- Run once in Supabase Dashboard → SQL Editor
-- Enables fast admin user deletion without API statement timeouts

CREATE OR REPLACE FUNCTION admin_delete_user(target_user_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  batch_size INT := 400;
  n INT;
  summary JSONB := '{}'::JSONB;
BEGIN
  PERFORM set_config('statement_timeout', '300000', true); -- 5 minutes for this function only

  UPDATE users SET "referredBy" = NULL WHERE "referredBy" = target_user_id;
  UPDATE wallets SET "frozenBy" = NULL WHERE "frozenBy" = target_user_id;
  UPDATE "supportTickets" SET "assignedTo" = NULL WHERE "assignedTo" = target_user_id;

  -- Batch wide updates so a single statement does not hit statement_timeout
  LOOP
    UPDATE transactions SET "approvedBy" = NULL
    WHERE id IN (SELECT id FROM transactions WHERE "approvedBy" = target_user_id LIMIT batch_size);
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    UPDATE transactions SET "rejectedBy" = NULL
    WHERE id IN (SELECT id FROM transactions WHERE "rejectedBy" = target_user_id LIMIT batch_size);
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    UPDATE "activityLogs" SET "adminUserId" = NULL
    WHERE id IN (SELECT id FROM "activityLogs" WHERE "adminUserId" = target_user_id LIMIT batch_size);
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    UPDATE "activityLogs" SET "reviewedBy" = NULL
    WHERE id IN (SELECT id FROM "activityLogs" WHERE "reviewedBy" = target_user_id LIMIT batch_size);
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    UPDATE transactions SET "parentTransactionId" = NULL
    WHERE id IN (
      SELECT id FROM transactions
      WHERE "userId" = target_user_id AND "parentTransactionId" IS NOT NULL
      LIMIT batch_size
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM "chatMessages" cm
    USING (
      SELECT id FROM "chatMessages" WHERE "userId" = target_user_id LIMIT batch_size
    ) batch
    WHERE cm.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM notifications notif
    USING (SELECT id FROM notifications WHERE "userId" = target_user_id LIMIT batch_size) batch
    WHERE notif.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
  END LOOP;

  -- Clear activity logs tied to this user's transactions before deleting transactions
  LOOP
    UPDATE "activityLogs" al SET "relatedTransactionId" = NULL
    WHERE al.id IN (
      SELECT al2.id FROM "activityLogs" al2
      INNER JOIN transactions t ON t.id = al2."relatedTransactionId"
      WHERE t."userId" = target_user_id
      LIMIT batch_size
    );
    GET DIAGNOSTICS n = ROW_COUNT;
    EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM "activityLogs" al
    USING (SELECT id FROM "activityLogs" WHERE "userId" = target_user_id LIMIT batch_size) batch
    WHERE al.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM "virtualCards" vc
    USING (SELECT id FROM "virtualCards" WHERE "userId" = target_user_id LIMIT batch_size) batch
    WHERE vc.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM beneficiaries b
    USING (SELECT id FROM beneficiaries WHERE "userId" = target_user_id LIMIT batch_size) batch
    WHERE b.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM "bankAccounts" ba
    USING (SELECT id FROM "bankAccounts" WHERE "userId" = target_user_id LIMIT batch_size) batch
    WHERE ba.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM "supportTickets" st
    USING (SELECT id FROM "supportTickets" WHERE "userId" = target_user_id LIMIT batch_size) batch
    WHERE st.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXIT WHEN n = 0;
  END LOOP;

  LOOP
    DELETE FROM transactions t
    USING (SELECT id FROM transactions WHERE "userId" = target_user_id LIMIT batch_size) batch
    WHERE t.id = batch.id;
    GET DIAGNOSTICS n = ROW_COUNT;
  EXIT WHEN n = 0;
  END LOOP;

  DELETE FROM wallets WHERE "userId" = target_user_id;
  DELETE FROM users WHERE id = target_user_id;

  summary := jsonb_build_object('success', true, 'userId', target_user_id);
  RETURN summary;
END;
$$;

GRANT EXECUTE ON FUNCTION admin_delete_user(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION admin_delete_user(UUID) TO postgres;

-- Refresh PostgREST schema cache so the API sees the function immediately
NOTIFY pgrst, 'reload schema';
