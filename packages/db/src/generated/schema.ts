/**
 * ФАЙЛ СГЕНЕРИРОВАН. Не правьте его руками.
 *
 * Источник правды — SQL-миграции в migrations/. Чтобы изменить схему, добавьте
 * миграцию и выполните `pnpm db:schema:generate`. Ручная правка будет затёрта,
 * а тест на дрейф её заметит.
 */
import { pgTable, index, foreignKey, unique, uuid, text, boolean, timestamp, check, integer, inet, bigint, jsonb, varchar, uniqueIndex, date, doublePrecision, numeric, primaryKey, pgView } from "drizzle-orm/pg-core"
import { citext, bytea, int4range } from "../custom-types.js";
import { sql } from "drizzle-orm"



export const users = pgTable("users", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	kcSub: text("kc_sub").notNull(),
	email: citext("email"),
	fullName: text("full_name").notNull(),
	position: text(),
	isActive: boolean("is_active").default(true).notNull(),
	contractorId: uuid("contractor_id"),
	lastLoginAt: timestamp("last_login_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_users_contractor").using("btree", table.contractorId.asc().nullsLast().op("uuid_ops")),
	index("ix_users_email").using("btree", table.email.asc().nullsLast().op("citext_ops")),
	unique("users_kc_sub_key").on(table.kcSub),
]);

export const authSessions = pgTable("auth_sessions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	kcSid: text("kc_sid"),
	refreshEnvelope: bytea("refresh_envelope").notNull(),
	keyVersion: integer("key_version").notNull(),
	csrfHash: text("csrf_hash").notNull(),
	idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	ip: inet(),
	ua: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_auth_sessions_expiry").using("btree", table.absoluteExpiresAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(revoked_at IS NULL)`),
	index("ix_auth_sessions_kc_sid").using("btree", table.kcSid.asc().nullsLast().op("text_ops")),
	index("ix_auth_sessions_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "auth_sessions_user_id_fkey"
		}).onDelete("cascade"),
	check("auth_sessions_expiry_chk", sql`idle_expires_at <= absolute_expires_at`),
	check("auth_sessions_key_version_chk", sql`key_version > 0`),
]);

export const auditLog = pgTable("audit_log", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "audit_log_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	actorUserId: uuid("actor_user_id"),
	actorEmailHmac: text("actor_email_hmac"),
	action: text().notNull(),
	entityType: text("entity_type").notNull(),
	entityId: text("entity_id"),
	objectId: uuid("object_id"),
	payload: jsonb().default({}).notNull(),
	ip: inet(),
	requestId: text("request_id"),
}, (table) => [
	index("ix_audit_log_action").using("btree", table.action.asc().nullsLast().op("text_ops"), table.at.desc().nullsFirst().op("timestamptz_ops")),
	index("ix_audit_log_actor").using("btree", table.actorUserId.asc().nullsLast().op("timestamptz_ops"), table.at.desc().nullsFirst().op("uuid_ops")),
	index("ix_audit_log_at").using("btree", table.at.desc().nullsFirst().op("timestamptz_ops")),
	index("ix_audit_log_entity").using("btree", table.entityType.asc().nullsLast().op("text_ops"), table.entityId.asc().nullsLast().op("text_ops")),
	index("ix_audit_log_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops"), table.at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.actorUserId],
			foreignColumns: [users.id],
			name: "audit_log_actor_user_id_fkey"
		}),
]);

export const counterparties = pgTable("counterparties", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	inn: text(),
	kpp: text(),
	ogrn: text(),
	legalAddress: text("legal_address"),
	kind: text().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_counterparties_inn").using("btree", table.inn.asc().nullsLast().op("text_ops")),
	index("ix_counterparties_ogrn").using("btree", table.ogrn.asc().nullsLast().op("text_ops")),
	check("counterparties_inn_chk", sql`inn ~ '^([0-9]{10}|[0-9]{12})$'::text`),
	check("counterparties_kpp_chk", sql`kpp ~ '^[0-9]{9}$'::text`),
	check("counterparties_ogrn_chk", sql`ogrn ~ '^([0-9]{13}|[0-9]{15})$'::text`),
	check("counterparties_kind_chk", sql`kind = ANY (ARRAY['customer'::text, 'general_contractor'::text, 'contractor'::text, 'supplier'::text])`),
]);

export const constructionObjects = pgTable("construction_objects", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code: varchar({ length: 5 }).notNull(),
	name: text().notNull(),
	fullName: text("full_name").notNull(),
	address: text(),
	isActive: boolean("is_active").default(true).notNull(),
	developerId: uuid("developer_id"),
	techCustomerId: uuid("tech_customer_id"),
	generalContractorId: uuid("general_contractor_id"),
	actNumberPattern: text("act_number_pattern"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_construction_objects_developer").using("btree", table.developerId.asc().nullsLast().op("uuid_ops")),
	index("ix_construction_objects_general_contractor").using("btree", table.generalContractorId.asc().nullsLast().op("uuid_ops")),
	index("ix_construction_objects_tech_customer").using("btree", table.techCustomerId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.developerId],
			foreignColumns: [counterparties.id],
			name: "construction_objects_developer_id_fkey"
		}),
	foreignKey({
			columns: [table.techCustomerId],
			foreignColumns: [counterparties.id],
			name: "construction_objects_tech_customer_id_fkey"
		}),
	foreignKey({
			columns: [table.generalContractorId],
			foreignColumns: [counterparties.id],
			name: "construction_objects_general_contractor_id_fkey"
		}),
	unique("construction_objects_code_key").on(table.code),
	check("construction_objects_code_chk", sql`(code)::text ~ '^[A-Za-z0-9]{5}$'::text`),
]);

export const objectSections = pgTable("object_sections", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	objectId: uuid("object_id").notNull(),
	code: text().notNull(),
	name: text().notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	sectionKindCode: text("section_kind_code").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_object_sections_kind").using("btree", table.sectionKindCode.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.objectId],
			foreignColumns: [constructionObjects.id],
			name: "object_sections_object_id_fkey"
		}),
	unique("object_sections_object_code_uq").on(table.code, table.objectId),
	unique("object_sections_object_id_uq").on(table.id, table.objectId),
	check("object_sections_sort_order_chk", sql`sort_order >= 0`),
]);

export const sectionKinds = pgTable("section_kinds", {
	code: text().primaryKey().notNull(),
	name: text().notNull(),
}, () => [
	check("section_kinds_code_chk", sql`code ~ '^[a-z][a-z0-9_]*$'::text`),
]);

export const sectionProfiles = pgTable("section_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	sectionKindCode: text("section_kind_code").notNull(),
	version: integer().notNull(),
	effectiveFrom: date("effective_from").notNull(),
	effectiveTo: date("effective_to"),
	expectedDocTypes: text("expected_doc_types").array().default([""]).notNull(),
	materialCategories: text("material_categories").array().default([""]).notNull(),
	materialMatrix: jsonb("material_matrix").default({}).notNull(),
	enabledRuleCodes: text("enabled_rule_codes").array().default([""]).notNull(),
	thresholds: jsonb().default({}).notNull(),
	autonomyLevel: text("autonomy_level").default('assisted').notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	publishedBy: uuid("published_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_section_profiles_published").using("btree", table.publishedBy.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_section_profiles_open_period").using("btree", table.sectionKindCode.asc().nullsLast().op("text_ops")).where(sql`((effective_to IS NULL) AND (published_at IS NOT NULL))`),
	foreignKey({
			columns: [table.sectionKindCode],
			foreignColumns: [sectionKinds.code],
			name: "section_profiles_section_kind_code_fkey"
		}),
	foreignKey({
			columns: [table.publishedBy],
			foreignColumns: [users.id],
			name: "section_profiles_published_by_fkey"
		}),
	unique("section_profiles_kind_version_uq").on(table.sectionKindCode, table.version),
	check("section_profiles_version_chk", sql`version > 0`),
	check("section_profiles_period_chk", sql`(effective_to IS NULL) OR (effective_from <= effective_to)`),
	check("section_profiles_autonomy_chk", sql`autonomy_level = ANY (ARRAY['assisted'::text, 'automatic'::text])`),
]);

export const objectRuleProfiles = pgTable("object_rule_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	objectId: uuid("object_id").notNull(),
	sectionId: uuid("section_id"),
	version: integer().notNull(),
	effectiveFrom: date("effective_from").notNull(),
	effectiveTo: date("effective_to"),
	overrides: jsonb().default({}).notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_object_rule_profiles_object").using("btree", table.objectId.asc().nullsLast().op("date_ops"), table.effectiveFrom.desc().nullsFirst().op("uuid_ops")),
	index("ix_object_rule_profiles_section").using("btree", table.sectionId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_object_rule_profiles_object_version").using("btree", table.objectId.asc().nullsLast().op("int4_ops"), table.version.asc().nullsLast().op("uuid_ops")).where(sql`(section_id IS NULL)`),
	uniqueIndex("ux_object_rule_profiles_section_version").using("btree", table.objectId.asc().nullsLast().op("uuid_ops"), table.sectionId.asc().nullsLast().op("uuid_ops"), table.version.asc().nullsLast().op("int4_ops")).where(sql`(section_id IS NOT NULL)`),
	foreignKey({
			columns: [table.objectId],
			foreignColumns: [constructionObjects.id],
			name: "object_rule_profiles_object_id_fkey"
		}),
	foreignKey({
			columns: [table.sectionId],
			foreignColumns: [objectSections.id],
			name: "object_rule_profiles_section_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.sectionId],
			foreignColumns: [objectSections.id, objectSections.objectId],
			name: "object_rule_profiles_section_fk"
		}),
	check("object_rule_profiles_version_chk", sql`version > 0`),
	check("object_rule_profiles_period_chk", sql`(effective_to IS NULL) OR (effective_from <= effective_to)`),
]);

export const rdDocuments = pgTable("rd_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	objectId: uuid("object_id").notNull(),
	cipher: text().notNull(),
	revision: text(),
	name: text(),
	designerId: uuid("designer_id"),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_rd_documents_designer").using("btree", table.designerId.asc().nullsLast().op("uuid_ops")),
	index("ix_rd_documents_object_cipher").using("btree", table.objectId.asc().nullsLast().op("text_ops"), table.cipher.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.objectId],
			foreignColumns: [constructionObjects.id],
			name: "rd_documents_object_id_fkey"
		}),
	foreignKey({
			columns: [table.designerId],
			foreignColumns: [counterparties.id],
			name: "rd_documents_designer_id_fkey"
		}),
]);

export const pageRoles = pgTable("page_roles", {
	code: text().primaryKey().notNull(),
	name: text().notNull(),
}, () => [
	check("page_roles_code_chk", sql`code ~ '^[a-z][a-z0-9_]*$'::text`),
]);

export const docTypes = pgTable("doc_types", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code: text().notNull(),
	name: text().notNull(),
	shortName: text("short_name").notNull(),
	groupCode: text("group_code").notNull(),
	kind: text().notNull(),
	hasAnnexes: boolean("has_annexes").default(false).notNull(),
	matchHints: jsonb("match_hints").default({}).notNull(),
	fieldSchema: jsonb("field_schema").default([]).notNull(),
	isSystem: boolean("is_system").default(false).notNull(),
	isFallback: boolean("is_fallback").default(false).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_doc_types_group").using("btree", table.groupCode.asc().nullsLast().op("int4_ops"), table.sortOrder.asc().nullsLast().op("int4_ops")),
	unique("doc_types_code_key").on(table.code),
	check("doc_types_code_chk", sql`code ~ '^[a-z][a-z0-9_]*$'::text`),
	check("doc_types_group_chk", sql`group_code = ANY (ARRAY['acts'::text, 'exec_schemes'::text, 'registries_logs'::text, 'quality_docs'::text, 'tests_conclusions'::text, 'networks'::text, 'facade'::text, 'org'::text, 'handover'::text, 'fallback'::text])`),
	check("doc_types_kind_chk", sql`kind = ANY (ARRAY['primary'::text, 'registry'::text, 'evidence'::text, 'fallback'::text])`),
	check("doc_types_sort_order_chk", sql`sort_order >= 0`),
]);

export const docTypeOverrides = pgTable("doc_type_overrides", {
	docTypeCode: text("doc_type_code").primaryKey().notNull(),
	name: text(),
	isActive: boolean("is_active"),
	sortOrder: integer("sort_order"),
	matchHints: jsonb("match_hints"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.docTypeCode],
			foreignColumns: [docTypes.code],
			name: "doc_type_overrides_doc_type_code_fkey"
		}),
]);

export const docTypeCandidates = pgTable("doc_type_candidates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	observedTitleNorm: text("observed_title_norm").notNull(),
	observedTitleSample: text("observed_title_sample").notNull(),
	occurrences: integer().default(1).notNull(),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sampleRevisionId: uuid("sample_revision_id"),
	sampleSourcePageId: uuid("sample_source_page_id"),
	status: text().default('new').notNull(),
	mappedDocTypeCode: text("mapped_doc_type_code"),
	reviewedBy: uuid("reviewed_by"),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_doc_type_candidates_mapped").using("btree", table.mappedDocTypeCode.asc().nullsLast().op("text_ops")),
	index("ix_doc_type_candidates_reviewed_by").using("btree", table.reviewedBy.asc().nullsLast().op("uuid_ops")),
	index("ix_doc_type_candidates_sample_page").using("btree", table.sampleSourcePageId.asc().nullsLast().op("uuid_ops")),
	index("ix_doc_type_candidates_sample_revision").using("btree", table.sampleRevisionId.asc().nullsLast().op("uuid_ops")),
	index("ix_doc_type_candidates_status").using("btree", table.status.asc().nullsLast().op("text_ops"), table.occurrences.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.mappedDocTypeCode],
			foreignColumns: [docTypes.code],
			name: "doc_type_candidates_mapped_doc_type_code_fkey"
		}),
	foreignKey({
			columns: [table.reviewedBy],
			foreignColumns: [users.id],
			name: "doc_type_candidates_reviewed_by_fkey"
		}),
	unique("doc_type_candidates_observed_title_norm_key").on(table.observedTitleNorm),
	check("doc_type_candidates_occurrences_chk", sql`occurrences > 0`),
	check("doc_type_candidates_status_chk", sql`status = ANY (ARRAY['new'::text, 'reviewing'::text, 'mapped'::text, 'ignored'::text])`),
	check("doc_type_candidates_mapped_chk", sql`(status <> 'mapped'::text) OR (mapped_doc_type_code IS NOT NULL)`),
]);

export const volumes = pgTable("volumes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	objectId: uuid("object_id").notNull(),
	sectionId: uuid("section_id").notNull(),
	code: text().notNull(),
	name: text().notNull(),
	isActive: boolean("is_active").default(true).notNull(),
	autoRunEnabled: boolean("auto_run_enabled").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_volumes_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	index("ix_volumes_section").using("btree", table.sectionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.objectId],
			foreignColumns: [constructionObjects.id],
			name: "volumes_object_id_fkey"
		}),
	foreignKey({
			columns: [table.sectionId],
			foreignColumns: [objectSections.id],
			name: "volumes_section_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId, table.sectionId],
			foreignColumns: [objectSections.id, objectSections.objectId],
			name: "volumes_section_fk"
		}),
	unique("volumes_object_code_uq").on(table.code, table.objectId),
	unique("volumes_object_id_uq").on(table.id, table.objectId),
]);

export const submissions = pgTable("submissions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	volumeId: uuid("volume_id").notNull(),
	objectId: uuid("object_id").notNull(),
	contractorId: uuid("contractor_id").notNull(),
	number: text(),
	title: text().notNull(),
	currentRevisionId: uuid("current_revision_id"),
	createdBy: uuid("created_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_submissions_contractor").using("btree", table.contractorId.asc().nullsLast().op("uuid_ops")),
	index("ix_submissions_created_by").using("btree", table.createdBy.asc().nullsLast().op("uuid_ops")),
	index("ix_submissions_current_revision").using("btree", table.currentRevisionId.asc().nullsLast().op("uuid_ops")),
	index("ix_submissions_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	index("ix_submissions_volume").using("btree", table.volumeId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.volumeId],
			foreignColumns: [volumes.id],
			name: "submissions_volume_id_fkey"
		}),
	foreignKey({
			columns: [table.objectId],
			foreignColumns: [constructionObjects.id],
			name: "submissions_object_id_fkey"
		}),
	foreignKey({
			columns: [table.contractorId],
			foreignColumns: [counterparties.id],
			name: "submissions_contractor_id_fkey"
		}),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [users.id],
			name: "submissions_created_by_fkey"
		}),
	foreignKey({
			columns: [table.volumeId, table.objectId],
			foreignColumns: [volumes.id, volumes.objectId],
			name: "submissions_volume_fk"
		}),
	unique("submissions_scope_uq").on(table.contractorId, table.id, table.objectId),
]);

export const submissionRevisions = pgTable("submission_revisions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	submissionId: uuid("submission_id").notNull(),
	objectId: uuid("object_id").notNull(),
	contractorId: uuid("contractor_id").notNull(),
	revisionNo: integer("revision_no").notNull(),
	parentRevisionId: uuid("parent_revision_id"),
	status: text().default('draft').notNull(),
	aggregateManifestHash: text("aggregate_manifest_hash"),
	version: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }),
	submittedBy: uuid("submitted_by"),
	decidedAt: timestamp("decided_at", { withTimezone: true, mode: 'string' }),
	decidedBy: uuid("decided_by"),
	returnReason: text("return_reason"),
}, (table) => [
	index("ix_submission_revisions_contractor").using("btree", table.contractorId.asc().nullsLast().op("uuid_ops")),
	index("ix_submission_revisions_decided_by").using("btree", table.decidedBy.asc().nullsLast().op("uuid_ops")),
	index("ix_submission_revisions_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	index("ix_submission_revisions_parent").using("btree", table.parentRevisionId.asc().nullsLast().op("uuid_ops")),
	index("ix_submission_revisions_status").using("btree", table.status.asc().nullsLast().op("text_ops")),
	index("ix_submission_revisions_submitted_by").using("btree", table.submittedBy.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_submission_revisions_single_draft").using("btree", table.submissionId.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'draft'::text)`),
	foreignKey({
			columns: [table.submissionId],
			foreignColumns: [submissions.id],
			name: "submission_revisions_submission_id_fkey"
		}),
	foreignKey({
			columns: [table.parentRevisionId],
			foreignColumns: [table.id],
			name: "submission_revisions_parent_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.submittedBy],
			foreignColumns: [users.id],
			name: "submission_revisions_submitted_by_fkey"
		}),
	foreignKey({
			columns: [table.decidedBy],
			foreignColumns: [users.id],
			name: "submission_revisions_decided_by_fkey"
		}),
	foreignKey({
			columns: [table.submissionId, table.objectId, table.contractorId],
			foreignColumns: [submissions.contractorId, submissions.id, submissions.objectId],
			name: "submission_revisions_scope_fk"
		}),
	unique("submission_revisions_no_uq").on(table.revisionNo, table.submissionId),
	unique("submission_revisions_submission_id_uq").on(table.id, table.submissionId),
	unique("submission_revisions_scope_uq").on(table.contractorId, table.id, table.objectId),
	unique("submission_revisions_object_uq").on(table.id, table.objectId),
	check("submission_revisions_revision_no_chk", sql`revision_no > 0`),
	check("submission_revisions_version_chk", sql`version >= 0`),
	check("submission_revisions_status_chk", sql`status = ANY (ARRAY['draft'::text, 'submitted'::text, 'in_review'::text, 'returned'::text, 'approved'::text, 'superseded'::text])`),
	check("submission_revisions_manifest_hash_chk", sql`aggregate_manifest_hash ~ '^[0-9a-f]{64}$'::text`),
	check("submission_revisions_parent_chk", sql`(revision_no = 1) OR (parent_revision_id IS NOT NULL)`),
]);

export const sourceFiles = pgTable("source_files", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	blobSha256: text("blob_sha256").notNull(),
	fileName: text("file_name").notNull(),
	sortOrder: integer("sort_order").notNull(),
	verifyState: text("verify_state").default('pending').notNull(),
	verifyError: text("verify_error"),
	signatureProbe: jsonb("signature_probe"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_source_files_blob").using("btree", table.blobSha256.asc().nullsLast().op("text_ops")),
	index("ix_source_files_verify_state").using("btree", table.verifyState.asc().nullsLast().op("text_ops")).where(sql`(verify_state <> 'ok'::text)`),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "source_files_revision_id_fkey"
		}),
	unique("source_files_order_uq").on(table.revisionId, table.sortOrder),
	unique("source_files_revision_id_uq").on(table.id, table.revisionId),
	check("source_files_sort_order_chk", sql`sort_order >= 0`),
	check("source_files_verify_state_chk", sql`verify_state = ANY (ARRAY['pending'::text, 'ok'::text, 'quarantined'::text])`),
]);

export const storedBlobs = pgTable("stored_blobs", {
	sha256: text().primaryKey().notNull(),
	s3Key: text("s3_key").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
	mime: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("stored_blobs_s3_key_key").on(table.s3Key),
	check("stored_blobs_sha256_chk", sql`sha256 ~ '^[0-9a-f]{64}$'::text`),
	check("stored_blobs_size_chk", sql`size_bytes >= 0`),
]);

export const sourcePages = pgTable("source_pages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	sourceFileId: uuid("source_file_id").notNull(),
	filePageIndex: integer("file_page_index").notNull(),
	revisionOrdinal: integer("revision_ordinal").notNull(),
	widthPx: integer("width_px").notNull(),
	heightPx: integer("height_px").notNull(),
	rotation: integer().default(0).notNull(),
	attentionFlags: text("attention_flags").array().default([""]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_source_pages_file").using("btree", table.sourceFileId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "source_pages_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceFileId],
			foreignColumns: [sourceFiles.id],
			name: "source_pages_source_file_id_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.sourceFileId],
			foreignColumns: [sourceFiles.id, sourceFiles.revisionId],
			name: "source_pages_file_fk"
		}),
	unique("source_pages_file_index_uq").on(table.filePageIndex, table.sourceFileId),
	unique("source_pages_revision_ordinal_uq").on(table.revisionId, table.revisionOrdinal),
	unique("source_pages_revision_id_uq").on(table.id, table.revisionId),
	check("source_pages_file_page_index_chk", sql`file_page_index >= 0`),
	check("source_pages_revision_ordinal_chk", sql`revision_ordinal >= 0`),
	check("source_pages_width_chk", sql`width_px > 0`),
	check("source_pages_height_chk", sql`height_px > 0`),
	check("source_pages_rotation_chk", sql`rotation = ANY (ARRAY[0, 90, 180, 270])`),
	check("source_pages_attention_flags_chk", sql`attention_flags <@ ARRAY['no_blocks'::text, 'low_coverage'::text, 'suspicious_overlap'::text, 'bbox_out_of_page'::text, 'degenerate_geometry'::text, 'tiny_block'::text, 'neighbor_mismatch'::text, 'blank_page_candidate'::text, 'missing_expected_stamp'::text, 'layout_hash_mismatch'::text]`),
]);

export const processingBundles = pgTable("processing_bundles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	aggregateManifestHash: text("aggregate_manifest_hash").notNull(),
	workingPdfBlobSha256: text("working_pdf_blob_sha256").notNull(),
	builderVersion: text("builder_version").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_processing_bundles_blob").using("btree", table.workingPdfBlobSha256.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "processing_bundles_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.workingPdfBlobSha256],
			foreignColumns: [storedBlobs.sha256],
			name: "processing_bundles_working_pdf_blob_sha256_fkey"
		}),
	unique("processing_bundles_manifest_uq").on(table.aggregateManifestHash, table.builderVersion, table.revisionId),
	unique("processing_bundles_revision_id_uq").on(table.id, table.revisionId),
	check("processing_bundles_manifest_hash_chk", sql`aggregate_manifest_hash ~ '^[0-9a-f]{64}$'::text`),
]);

export const layoutRevisions = pgTable("layout_revisions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	objectId: uuid("object_id").notNull(),
	bundleId: uuid("bundle_id").notNull(),
	revisionNo: integer("revision_no").notNull(),
	state: text().default('draft').notNull(),
	blocksHash: text("blocks_hash"),
	version: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	frozenAt: timestamp("frozen_at", { withTimezone: true, mode: 'string' }),
	frozenBy: uuid("frozen_by"),
	layoutProfileId: uuid("layout_profile_id"),
	detectorProfile: text("detector_profile").default('rf_detr').notNull(),
	firstManualEditAt: timestamp("first_manual_edit_at", { withTimezone: true, mode: 'string' }),
	firstManualEditBy: uuid("first_manual_edit_by"),
}, (table) => [
	index("ix_layout_revisions_bundle").using("btree", table.bundleId.asc().nullsLast().op("uuid_ops")),
	index("ix_layout_revisions_frozen_by").using("btree", table.frozenBy.asc().nullsLast().op("uuid_ops")),
	index("ix_layout_revisions_manual_editor").using("btree", table.firstManualEditBy.asc().nullsLast().op("uuid_ops")),
	index("ix_layout_revisions_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	index("ix_layout_revisions_profile").using("btree", table.layoutProfileId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_layout_revisions_single_draft").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")).where(sql`(state = 'draft'::text)`),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "layout_revisions_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.bundleId],
			foreignColumns: [processingBundles.id],
			name: "layout_revisions_bundle_id_fkey"
		}),
	foreignKey({
			columns: [table.frozenBy],
			foreignColumns: [users.id],
			name: "layout_revisions_frozen_by_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.objectId],
			foreignColumns: [submissionRevisions.id, submissionRevisions.objectId],
			name: "layout_revisions_scope_fk"
		}),
	foreignKey({
			columns: [table.revisionId, table.bundleId],
			foreignColumns: [processingBundles.id, processingBundles.revisionId],
			name: "layout_revisions_bundle_fk"
		}),
	foreignKey({
			columns: [table.firstManualEditBy],
			foreignColumns: [users.id],
			name: "layout_revisions_first_manual_edit_by_fkey"
		}),
	unique("layout_revisions_no_uq").on(table.revisionId, table.revisionNo),
	unique("layout_revisions_revision_id_uq").on(table.id, table.revisionId),
	unique("layout_revisions_scope_uq").on(table.bundleId, table.id, table.objectId, table.revisionId),
	check("layout_revisions_revision_no_chk", sql`revision_no > 0`),
	check("layout_revisions_version_chk", sql`version >= 0`),
	check("layout_revisions_state_chk", sql`state = ANY (ARRAY['draft'::text, 'frozen'::text, 'superseded'::text])`),
	check("layout_revisions_blocks_hash_chk", sql`blocks_hash ~ '^[0-9a-f]{64}$'::text`),
	check("layout_revisions_frozen_chk", sql`(state = 'draft'::text) OR ((blocks_hash IS NOT NULL) AND (frozen_at IS NOT NULL))`),
	check("layout_revisions_detector_profile_chk", sql`detector_profile = ANY (ARRAY['rf_detr'::text, 'full_page'::text])`),
	check("layout_revisions_manual_edit_chk", sql`(first_manual_edit_at IS NULL) = (first_manual_edit_by IS NULL)`),
]);

export const artifactVersions = pgTable("artifact_versions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	recognitionRunId: uuid("recognition_run_id").notNull(),
	kind: text().notNull(),
	s3Key: text("s3_key").notNull(),
	artifactSha256: text("artifact_sha256").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteSize: bigint("byte_size", { mode: "number" }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("artifact_versions_run_kind_uq").on(table.kind, table.recognitionRunId),
	unique("artifact_versions_run_id_uq").on(table.id, table.recognitionRunId),
	check("artifact_versions_sha256_chk", sql`artifact_sha256 ~ '^[0-9a-f]{64}$'::text`),
	check("artifact_versions_byte_size_chk", sql`byte_size >= 0`),
	check("artifact_versions_kind_chk", sql`kind = ANY (ARRAY['zip'::text, 'md'::text, 'html'::text, 'blocks_json'::text, 'qa'::text, 'canonical'::text])`),
]);

export const rdRunDocuments = pgTable("rd_run_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	layoutRevisionId: uuid("layout_revision_id").notNull(),
	rdDocumentId: text("rd_document_id").notNull(),
	rdProjectId: text("rd_project_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	closedAt: timestamp("closed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	foreignKey({
			columns: [table.layoutRevisionId],
			foreignColumns: [layoutRevisions.id],
			name: "rd_run_documents_layout_revision_id_fkey"
		}),
	unique("rd_run_documents_layout_revision_id_key").on(table.layoutRevisionId),
	unique("rd_run_documents_layout_revision_id_uq").on(table.id, table.layoutRevisionId),
]);

export const recognitionRuns = pgTable("recognition_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	layoutRevisionId: uuid("layout_revision_id").notNull(),
	rdRunDocumentId: uuid("rd_run_document_id"),
	rdJobId: text("rd_job_id"),
	localLayoutHash: text("local_layout_hash").notNull(),
	remoteLayoutHashBefore: text("remote_layout_hash_before"),
	remoteLayoutHashAfter: text("remote_layout_hash_after"),
	workingPdfSha256: text("working_pdf_sha256").notNull(),
	settingsSnapshot: jsonb("settings_snapshot").default({}).notNull(),
	status: text().default('running').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	counts: jsonb().default({}).notNull(),
	warnings: jsonb().default([]).notNull(),
}, (table) => [
	index("ix_recognition_runs_layout").using("btree", table.layoutRevisionId.asc().nullsLast().op("uuid_ops")),
	index("ix_recognition_runs_rd_document").using("btree", table.rdRunDocumentId.asc().nullsLast().op("uuid_ops")),
	index("ix_recognition_runs_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")),
	index("ix_recognition_runs_status").using("btree", table.status.asc().nullsLast().op("text_ops")).where(sql`(status = 'running'::text)`),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "recognition_runs_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.layoutRevisionId],
			foreignColumns: [layoutRevisions.id],
			name: "recognition_runs_layout_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.rdRunDocumentId],
			foreignColumns: [rdRunDocuments.id],
			name: "recognition_runs_rd_run_document_id_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.layoutRevisionId],
			foreignColumns: [layoutRevisions.id, layoutRevisions.revisionId],
			name: "recognition_runs_layout_fk"
		}),
	foreignKey({
			columns: [table.layoutRevisionId, table.rdRunDocumentId],
			foreignColumns: [rdRunDocuments.id, rdRunDocuments.layoutRevisionId],
			name: "recognition_runs_rd_document_fk"
		}),
	unique("recognition_runs_revision_id_uq").on(table.id, table.revisionId),
	unique("recognition_runs_layout_revision_uq").on(table.id, table.layoutRevisionId),
	check("recognition_runs_status_chk", sql`status = ANY (ARRAY['running'::text, 'done'::text, 'integrity_error'::text, 'failed'::text])`),
	check("recognition_runs_local_hash_chk", sql`local_layout_hash ~ '^[0-9a-f]{64}$'::text`),
	check("recognition_runs_remote_before_chk", sql`remote_layout_hash_before ~ '^[0-9a-f]{64}$'::text`),
	check("recognition_runs_remote_after_chk", sql`remote_layout_hash_after ~ '^[0-9a-f]{64}$'::text`),
	check("recognition_runs_working_pdf_chk", sql`working_pdf_sha256 ~ '^[0-9a-f]{64}$'::text`),
	check("recognition_runs_finished_chk", sql`(status = 'running'::text) OR (finished_at IS NOT NULL)`),
]);

export const layoutBlocks = pgTable("layout_blocks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	layoutRevisionId: uuid("layout_revision_id").notNull(),
	revisionId: uuid("revision_id").notNull(),
	bundleId: uuid("bundle_id").notNull(),
	sourcePageId: uuid("source_page_id").notNull(),
	workingPageIndex: integer("working_page_index").notNull(),
	objectId: uuid("object_id").notNull(),
	blockType: text("block_type").notNull(),
	shapeType: text("shape_type").notNull(),
	x0: doublePrecision().notNull(),
	y0: doublePrecision().notNull(),
	x1: doublePrecision().notNull(),
	y1: doublePrecision().notNull(),
	sortOrder: integer("sort_order").notNull(),
	source: text().notNull(),
	detectorProvenance: text("detector_provenance").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	detectionScore: doublePrecision("detection_score"),
	detectionModelVersion: text("detection_model_version"),
}, (table) => [
	index("ix_layout_blocks_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	index("ix_layout_blocks_revision_page").using("btree", table.layoutRevisionId.asc().nullsLast().op("uuid_ops"), table.sourcePageId.asc().nullsLast().op("uuid_ops"), table.sortOrder.asc().nullsLast().op("uuid_ops")),
	index("ix_layout_blocks_source_page").using("btree", table.sourcePageId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.layoutRevisionId],
			foreignColumns: [layoutRevisions.id],
			name: "layout_blocks_layout_revision_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sourcePageId],
			foreignColumns: [sourcePages.id],
			name: "layout_blocks_source_page_id_fkey"
		}),
	foreignKey({
			columns: [table.layoutRevisionId, table.revisionId, table.bundleId, table.objectId],
			foreignColumns: [layoutRevisions.bundleId, layoutRevisions.id, layoutRevisions.objectId, layoutRevisions.revisionId],
			name: "layout_blocks_scope_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.revisionId, table.sourcePageId],
			foreignColumns: [sourcePages.id, sourcePages.revisionId],
			name: "layout_blocks_source_page_fk"
		}),
	unique("layout_blocks_revision_id_uq").on(table.id, table.revisionId),
	unique("layout_blocks_layout_revision_uq").on(table.id, table.layoutRevisionId),
	check("layout_blocks_working_page_index_chk", sql`working_page_index >= 0`),
	check("layout_blocks_sort_order_chk", sql`sort_order >= 0`),
	check("layout_blocks_block_type_chk", sql`block_type = ANY (ARRAY['text'::text, 'image'::text, 'stamp'::text])`),
	check("layout_blocks_shape_type_chk", sql`shape_type = ANY (ARRAY['rectangle'::text, 'polygon'::text])`),
	check("layout_blocks_source_chk", sql`source = ANY (ARRAY['auto'::text, 'user'::text])`),
	check("layout_blocks_provenance_chk", sql`detector_provenance = ANY (ARRAY['rf_detr'::text, 'full_page'::text, 'user'::text, 'unavailable'::text])`),
	check("layout_blocks_coords_chk", sql`(x0 >= (0)::double precision) AND (y0 >= (0)::double precision) AND (x1 <= (1)::double precision) AND (y1 <= (1)::double precision) AND (x0 <= x1) AND (y0 <= y1)`),
	check("layout_blocks_detection_score_chk", sql`(detection_score IS NULL) OR ((detection_score >= (0)::double precision) AND (detection_score <= (1)::double precision))`),
]);

export const blockResults = pgTable("block_results", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	layoutRevisionId: uuid("layout_revision_id").notNull(),
	layoutBlockId: uuid("layout_block_id").notNull(),
	recognitionRunId: uuid("recognition_run_id").notNull(),
	resultType: text("result_type").notNull(),
	contentHtml: text("content_html"),
	contentMd: text("content_md"),
	contentJson: jsonb("content_json"),
	modelId: text("model_id"),
	confidence: doublePrecision(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_block_results_block").using("btree", table.layoutBlockId.asc().nullsLast().op("uuid_ops")),
	index("ix_block_results_run").using("btree", table.recognitionRunId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.layoutRevisionId, table.layoutBlockId],
			foreignColumns: [layoutBlocks.id, layoutBlocks.layoutRevisionId],
			name: "block_results_block_fk"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.layoutBlockId],
			foreignColumns: [layoutBlocks.id],
			name: "block_results_layout_block_id_fkey"
		}).onDelete("restrict"),
	foreignKey({
			columns: [table.recognitionRunId],
			foreignColumns: [recognitionRuns.id],
			name: "block_results_recognition_run_id_fkey"
		}),
	foreignKey({
			columns: [table.layoutRevisionId, table.recognitionRunId],
			foreignColumns: [recognitionRuns.id, recognitionRuns.layoutRevisionId],
			name: "block_results_run_fk"
		}),
	unique("block_results_block_id_uq").on(table.id, table.layoutBlockId),
	unique("block_results_run_block_uq").on(table.layoutBlockId, table.recognitionRunId),
	check("block_results_confidence_chk", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
]);

export const currentBlockResult = pgTable("current_block_result", {
	layoutBlockId: uuid("layout_block_id").primaryKey().notNull(),
	blockResultId: uuid("block_result_id").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_current_block_result_result").using("btree", table.blockResultId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.layoutBlockId],
			foreignColumns: [layoutBlocks.id],
			name: "current_block_result_layout_block_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.layoutBlockId, table.blockResultId],
			foreignColumns: [blockResults.id, blockResults.layoutBlockId],
			name: "current_block_result_result_fk"
		}),
]);

export const aiRuns = pgTable("ai_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	stage: text().notNull(),
	provider: text().notNull(),
	model: text().notNull(),
	promptCode: text("prompt_code"),
	promptVersion: integer("prompt_version"),
	inputHash: text("input_hash"),
	outputHash: text("output_hash"),
	tokensIn: integer("tokens_in"),
	tokensOut: integer("tokens_out"),
	cost: numeric({ precision: 12, scale:  4 }),
	latencyMs: integer("latency_ms"),
	structuredResult: jsonb("structured_result"),
	requestId: text("request_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_ai_runs_request").using("btree", table.requestId.asc().nullsLast().op("text_ops")),
	index("ix_ai_runs_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	index("ix_ai_runs_stage").using("btree", table.stage.asc().nullsLast().op("text_ops"), table.createdAt.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "ai_runs_revision_id_fkey"
		}),
	check("ai_runs_provider_chk", sql`provider = ANY (ARRAY['proxy_llm'::text, 'rdweb'::text, 'recorded'::text])`),
	check("ai_runs_input_hash_chk", sql`input_hash ~ '^[0-9a-f]{64}$'::text`),
	check("ai_runs_output_hash_chk", sql`output_hash ~ '^[0-9a-f]{64}$'::text`),
	check("ai_runs_tokens_chk", sql`((tokens_in IS NULL) OR (tokens_in >= 0)) AND ((tokens_out IS NULL) OR (tokens_out >= 0))`),
	check("ai_runs_stage_chk", sql`stage = ANY (ARRAY['page_classify'::text, 'doc_split'::text, 'extract'::text, 'check'::text, 'summary'::text, 'recognize'::text])`),
]);

export const pageTextVersions = pgTable("page_text_versions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	sourcePageId: uuid("source_page_id").notNull(),
	recognitionRunId: uuid("recognition_run_id").notNull(),
	artifactVersionId: uuid("artifact_version_id").notNull(),
	textMd: text("text_md").notNull(),
	textSha256: text("text_sha256").notNull(),
	offsetConvention: text("offset_convention").default('utf16-code-unit').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	renderVersion: text("render_version").default('recognition.page_text.v1').notNull(),
}, (table) => [
	index("ix_page_text_versions_artifact").using("btree", table.artifactVersionId.asc().nullsLast().op("uuid_ops")),
	index("ix_page_text_versions_run").using("btree", table.recognitionRunId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.sourcePageId],
			foreignColumns: [sourcePages.id],
			name: "page_text_versions_source_page_id_fkey"
		}),
	foreignKey({
			columns: [table.recognitionRunId],
			foreignColumns: [recognitionRuns.id],
			name: "page_text_versions_recognition_run_id_fkey"
		}),
	foreignKey({
			columns: [table.artifactVersionId],
			foreignColumns: [artifactVersions.id],
			name: "page_text_versions_artifact_version_id_fkey"
		}),
	foreignKey({
			columns: [table.recognitionRunId, table.artifactVersionId],
			foreignColumns: [artifactVersions.id, artifactVersions.recognitionRunId],
			name: "page_text_versions_artifact_fk"
		}),
	foreignKey({
			columns: [table.revisionId, table.sourcePageId],
			foreignColumns: [sourcePages.id, sourcePages.revisionId],
			name: "page_text_versions_page_fk"
		}),
	foreignKey({
			columns: [table.revisionId, table.recognitionRunId],
			foreignColumns: [recognitionRuns.id, recognitionRuns.revisionId],
			name: "page_text_versions_run_fk"
		}),
	unique("page_text_versions_page_run_uq").on(table.recognitionRunId, table.sourcePageId),
	unique("page_text_versions_revision_id_uq").on(table.id, table.revisionId),
	check("page_text_versions_sha256_chk", sql`text_sha256 ~ '^[0-9a-f]{64}$'::text`),
	check("page_text_versions_offset_convention_chk", sql`offset_convention = 'utf16-code-unit'::text`),
	check("page_text_versions_render_version_chk", sql`render_version ~ '^[a-z0-9][a-z0-9._-]*$'::text`),
]);

export const pageAssignments = pgTable("page_assignments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	sourcePageId: uuid("source_page_id").notNull(),
	documentId: uuid("document_id"),
	sortOrder: integer("sort_order"),
	pageRoleCode: text("page_role_code"),
	reason: text(),
	needsReview: boolean("needs_review").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_page_assignments_document").using("btree", table.documentId.asc().nullsLast().op("int4_ops"), table.sortOrder.asc().nullsLast().op("uuid_ops")),
	index("ix_page_assignments_role").using("btree", table.pageRoleCode.asc().nullsLast().op("text_ops")),
	index("ix_page_assignments_source_page").using("btree", table.sourcePageId.asc().nullsLast().op("uuid_ops")),
	index("ix_page_assignments_unassigned").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")).where(sql`(document_id IS NULL)`),
	foreignKey({
			columns: [table.pageRoleCode],
			foreignColumns: [pageRoles.code],
			name: "page_assignments_page_role_code_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.sourcePageId],
			foreignColumns: [sourcePages.id, sourcePages.revisionId],
			name: "page_assignments_source_page_fk"
		}),
	unique("page_assignments_page_uq").on(table.revisionId, table.sourcePageId),
	check("page_assignments_sort_order_chk", sql`(sort_order IS NULL) OR (sort_order >= 0)`),
	check("page_assignments_state_chk", sql`((document_id IS NOT NULL) AND (sort_order IS NOT NULL) AND (reason IS NULL)) OR ((document_id IS NULL) AND (sort_order IS NULL) AND (page_role_code IS NULL) AND (reason IS NOT NULL))`),
]);

export const registryRows = pgTable("registry_rows", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	documentId: uuid("document_id").notNull(),
	rowNo: integer("row_no").notNull(),
	sectionTitle: text("section_title"),
	docNameRaw: text("doc_name_raw").notNull(),
	docNoRaw: text("doc_no_raw"),
	orgRaw: text("org_raw"),
	docNoNorm: text("doc_no_norm"),
	docNoFolded: text("doc_no_folded"),
	validFrom: date("valid_from"),
	validTo: date("valid_to"),
	issuedAt: date("issued_at"),
	matchedDocumentId: uuid("matched_document_id"),
	matchScore: doublePrecision("match_score"),
	matchState: text("match_state").default('missing').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	ordinal: integer().notNull(),
}, (table) => [
	index("ix_registry_rows_document_ordinal").using("btree", table.documentId.asc().nullsLast().op("uuid_ops"), table.ordinal.asc().nullsLast().op("int4_ops")),
	index("ix_registry_rows_matched").using("btree", table.matchedDocumentId.asc().nullsLast().op("uuid_ops")),
	index("ix_registry_rows_no_folded").using("btree", table.docNoFolded.asc().nullsLast().op("text_ops")),
	index("ix_registry_rows_no_norm").using("btree", table.docNoNorm.asc().nullsLast().op("text_ops")),
	index("ix_registry_rows_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")),
	unique("registry_rows_ordinal_uq").on(table.documentId, table.ordinal),
	check("registry_rows_row_no_chk", sql`row_no > 0`),
	check("registry_rows_match_score_chk", sql`(match_score IS NULL) OR ((match_score >= (0)::double precision) AND (match_score <= (1)::double precision))`),
	check("registry_rows_match_state_chk", sql`match_state = ANY (ARRAY['matched'::text, 'missing'::text, 'extra'::text, 'ambiguous'::text])`),
	check("registry_rows_matched_chk", sql`(match_state <> 'matched'::text) OR (matched_document_id IS NOT NULL)`),
	check("registry_rows_ordinal_chk", sql`ordinal >= 0`),
]);

export const fieldValues = pgTable("field_values", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	documentId: uuid("document_id").notNull(),
	fieldCode: text("field_code").notNull(),
	valueText: text("value_text"),
	valueDate: date("value_date"),
	valueNum: numeric("value_num"),
	valueJson: jsonb("value_json"),
	confidence: doublePrecision(),
	isVerified: boolean("is_verified").default(false).notNull(),
	extractorVersion: text("extractor_version").notNull(),
	pageTextVersionId: uuid("page_text_version_id"),
	sourceBlockId: uuid("source_block_id"),
	charSpan: int4range("char_span"),
	quote: text(),
	extractedBy: text("extracted_by").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_field_values_document").using("btree", table.documentId.asc().nullsLast().op("uuid_ops"), table.fieldCode.asc().nullsLast().op("text_ops")),
	index("ix_field_values_page_text").using("btree", table.pageTextVersionId.asc().nullsLast().op("uuid_ops")),
	index("ix_field_values_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")),
	index("ix_field_values_source_block").using("btree", table.sourceBlockId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.pageTextVersionId],
			foreignColumns: [pageTextVersions.id],
			name: "field_values_page_text_version_id_fkey"
		}),
	foreignKey({
			columns: [table.sourceBlockId],
			foreignColumns: [layoutBlocks.id],
			name: "field_values_source_block_id_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.pageTextVersionId],
			foreignColumns: [pageTextVersions.id, pageTextVersions.revisionId],
			name: "field_values_page_text_fk"
		}),
	foreignKey({
			columns: [table.revisionId, table.sourceBlockId],
			foreignColumns: [layoutBlocks.id, layoutBlocks.revisionId],
			name: "field_values_source_block_fk"
		}),
	check("field_values_field_code_chk", sql`field_code ~ '^[a-z][a-z0-9_]*$'::text`),
	check("field_values_confidence_chk", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("field_values_extracted_by_chk", sql`extracted_by = ANY (ARRAY['rule'::text, 'llm'::text, 'manual'::text])`),
	check("field_values_span_source_chk", sql`(char_span IS NULL) OR (page_text_version_id IS NOT NULL)`),
	check("field_values_span_bounds_chk", sql`(char_span IS NULL) OR (lower(char_span) >= 0)`),
]);

export const materials = pgTable("materials", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	nameRaw: text("name_raw").notNull(),
	nameNorm: text("name_norm").notNull(),
	mark: text(),
	sizeSpec: text("size_spec"),
	categoryCode: text("category_code"),
	source: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_materials_name_norm").using("gin", table.nameNorm.asc().nullsLast().op("gin_trgm_ops")),
	index("ix_materials_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "materials_revision_id_fkey"
		}),
	unique("materials_revision_id_uq").on(table.id, table.revisionId),
	check("materials_source_chk", sql`source = ANY (ARRAY['act_p3'::text, 'registry'::text, 'quality_doc'::text, 'manual'::text])`),
	check("materials_category_chk", sql`(category_code IS NULL) OR (category_code ~ '^[a-z][a-z0-9_]*$'::text)`),
]);

export const batches = pgTable("batches", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	materialId: uuid("material_id").notNull(),
	batchNo: text("batch_no"),
	heatNo: text("heat_no"),
	manufacturedAt: date("manufactured_at"),
	volume: numeric(),
	unit: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_batches_material").using("btree", table.materialId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "batches_material_id_fkey"
		}).onDelete("cascade"),
	unique("batches_material_id_uq").on(table.id, table.materialId),
]);

export const materialDocuments = pgTable("material_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	materialId: uuid("material_id").notNull(),
	documentId: uuid("document_id").notNull(),
	batchId: uuid("batch_id"),
	relation: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_material_documents_batch").using("btree", table.batchId.asc().nullsLast().op("uuid_ops")),
	index("ix_material_documents_document").using("btree", table.documentId.asc().nullsLast().op("uuid_ops")),
	index("ix_material_documents_material").using("btree", table.materialId.asc().nullsLast().op("uuid_ops")),
	index("ix_material_documents_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_material_documents_with_batch").using("btree", table.materialId.asc().nullsLast().op("text_ops"), table.documentId.asc().nullsLast().op("text_ops"), table.batchId.asc().nullsLast().op("text_ops"), table.relation.asc().nullsLast().op("uuid_ops")).where(sql`(batch_id IS NOT NULL)`),
	uniqueIndex("ux_material_documents_without_batch").using("btree", table.materialId.asc().nullsLast().op("uuid_ops"), table.documentId.asc().nullsLast().op("text_ops"), table.relation.asc().nullsLast().op("text_ops")).where(sql`(batch_id IS NULL)`),
	foreignKey({
			columns: [table.materialId],
			foreignColumns: [materials.id],
			name: "material_documents_material_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.materialId, table.batchId],
			foreignColumns: [batches.id, batches.materialId],
			name: "material_documents_batch_fk"
		}),
	foreignKey({
			columns: [table.revisionId, table.materialId],
			foreignColumns: [materials.id, materials.revisionId],
			name: "material_documents_material_fk"
		}).onDelete("cascade"),
	check("material_documents_relation_chk", sql`relation ~ '^[a-z][a-z0-9_]*$'::text`),
]);

export const ruleDefinitions = pgTable("rule_definitions", {
	code: text().primaryKey().notNull(),
	title: text().notNull(),
	docTypeCode: text("doc_type_code"),
	level: text().notNull(),
	kind: text().notNull(),
	defaultSeverity: text("default_severity").notNull(),
	waiverRoles: text("waiver_roles").array().default([""]).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_rule_definitions_doc_type").using("btree", table.docTypeCode.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.docTypeCode],
			foreignColumns: [docTypes.code],
			name: "rule_definitions_doc_type_code_fkey"
		}),
	check("rule_definitions_code_chk", sql`code ~ '^[A-Z][A-Z0-9]*([.][A-Z0-9]+)*$'::text`),
	check("rule_definitions_severity_chk", sql`default_severity = ANY (ARRAY['error'::text, 'warning'::text, 'info'::text])`),
	check("rule_definitions_level_chk", sql`level ~ '^[a-z][a-z0-9_]*$'::text`),
	check("rule_definitions_kind_chk", sql`kind ~ '^[a-z][a-z0-9_]*$'::text`),
	check("rule_definitions_waiver_roles_chk", sql`waiver_roles <@ ARRAY['contractor'::text, 'engineer'::text, 'manager'::text, 'admin'::text]`),
]);

export const rulesetVersions = pgTable("ruleset_versions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	version: text().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	publishedBy: uuid("published_by"),
	notes: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_ruleset_versions_published_by").using("btree", table.publishedBy.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.publishedBy],
			foreignColumns: [users.id],
			name: "ruleset_versions_published_by_fkey"
		}),
	unique("ruleset_versions_version_key").on(table.version),
	check("ruleset_versions_published_chk", sql`(published_at IS NULL) OR (published_by IS NOT NULL)`),
]);

export const validationRuns = pgTable("validation_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	rulesetVersionId: uuid("ruleset_version_id").notNull(),
	objectRuleProfileId: uuid("object_rule_profile_id"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	counts: jsonb().default({}).notNull(),
	sectionProfileId: uuid("section_profile_id"),
}, (table) => [
	index("ix_validation_runs_profile").using("btree", table.objectRuleProfileId.asc().nullsLast().op("uuid_ops")),
	index("ix_validation_runs_revision").using("btree", table.revisionId.asc().nullsLast().op("timestamptz_ops"), table.startedAt.desc().nullsFirst().op("uuid_ops")),
	index("ix_validation_runs_ruleset").using("btree", table.rulesetVersionId.asc().nullsLast().op("uuid_ops")),
	index("ix_validation_runs_section_profile").using("btree", table.sectionProfileId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "validation_runs_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.rulesetVersionId],
			foreignColumns: [rulesetVersions.id],
			name: "validation_runs_ruleset_version_id_fkey"
		}),
	foreignKey({
			columns: [table.objectRuleProfileId],
			foreignColumns: [objectRuleProfiles.id],
			name: "validation_runs_object_rule_profile_id_fkey"
		}),
	foreignKey({
			columns: [table.sectionProfileId],
			foreignColumns: [sectionProfiles.id],
			name: "validation_runs_section_profile_id_fkey"
		}),
	unique("validation_runs_revision_uq").on(table.id, table.revisionId),
]);

export const findings = pgTable("findings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	validationRunId: uuid("validation_run_id").notNull(),
	revisionId: uuid("revision_id").notNull(),
	objectId: uuid("object_id").notNull(),
	contractorId: uuid("contractor_id").notNull(),
	ruleCode: text("rule_code").notNull(),
	severity: text().notNull(),
	state: text().default('open').notNull(),
	origin: text().notNull(),
	isBlocking: boolean("is_blocking").default(false).notNull(),
	confirmedBy: uuid("confirmed_by"),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: 'string' }),
	targetType: text("target_type").notNull(),
	targetId: uuid("target_id"),
	sourcePageId: uuid("source_page_id"),
	blockId: uuid("block_id"),
	message: text().notNull(),
	hint: text(),
	waivedBy: uuid("waived_by"),
	waivedAt: timestamp("waived_at", { withTimezone: true, mode: 'string' }),
	waiverReason: text("waiver_reason"),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_findings_block").using("btree", table.blockId.asc().nullsLast().op("uuid_ops")),
	index("ix_findings_blocking").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")).where(sql`is_blocking`),
	index("ix_findings_confirmed_by").using("btree", table.confirmedBy.asc().nullsLast().op("uuid_ops")),
	index("ix_findings_contractor").using("btree", table.contractorId.asc().nullsLast().op("uuid_ops")),
	index("ix_findings_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	index("ix_findings_revision_state").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops"), table.state.asc().nullsLast().op("text_ops"), table.severity.asc().nullsLast().op("text_ops")),
	index("ix_findings_rule").using("btree", table.ruleCode.asc().nullsLast().op("text_ops")),
	index("ix_findings_run").using("btree", table.validationRunId.asc().nullsLast().op("uuid_ops")),
	index("ix_findings_source_page").using("btree", table.sourcePageId.asc().nullsLast().op("uuid_ops")),
	index("ix_findings_waived_by").using("btree", table.waivedBy.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.validationRunId],
			foreignColumns: [validationRuns.id],
			name: "findings_validation_run_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.ruleCode],
			foreignColumns: [ruleDefinitions.code],
			name: "findings_rule_code_fkey"
		}),
	foreignKey({
			columns: [table.confirmedBy],
			foreignColumns: [users.id],
			name: "findings_confirmed_by_fkey"
		}),
	foreignKey({
			columns: [table.sourcePageId],
			foreignColumns: [sourcePages.id],
			name: "findings_source_page_id_fkey"
		}),
	foreignKey({
			columns: [table.blockId],
			foreignColumns: [layoutBlocks.id],
			name: "findings_block_id_fkey"
		}),
	foreignKey({
			columns: [table.waivedBy],
			foreignColumns: [users.id],
			name: "findings_waived_by_fkey"
		}),
	foreignKey({
			columns: [table.validationRunId, table.revisionId],
			foreignColumns: [validationRuns.id, validationRuns.revisionId],
			name: "findings_run_fk"
		}),
	foreignKey({
			columns: [table.revisionId, table.objectId, table.contractorId],
			foreignColumns: [submissionRevisions.contractorId, submissionRevisions.id, submissionRevisions.objectId],
			name: "findings_scope_fk"
		}),
	check("findings_severity_chk", sql`severity = ANY (ARRAY['error'::text, 'warning'::text, 'info'::text])`),
	check("findings_state_chk", sql`state = ANY (ARRAY['open'::text, 'resolved'::text, 'waived'::text, 'undetermined'::text])`),
	check("findings_origin_chk", sql`origin = ANY (ARRAY['deterministic'::text, 'llm'::text, 'external_unavailable'::text])`),
	check("findings_target_type_chk", sql`target_type = ANY (ARRAY['revision'::text, 'source_page'::text, 'document'::text, 'field_value'::text, 'registry_row'::text, 'material'::text, 'batch'::text])`),
	check("findings_llm_blocking_chk", sql`(NOT ((origin = 'llm'::text) AND is_blocking)) OR (confirmed_by IS NOT NULL)`),
	check("findings_undetermined_chk", sql`NOT ((state = 'undetermined'::text) AND is_blocking)`),
	check("findings_waived_chk", sql`(state <> 'waived'::text) OR ((waived_by IS NOT NULL) AND (waiver_reason IS NOT NULL))`),
]);

export const reviewActions = pgTable("review_actions", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	actorUserId: uuid("actor_user_id").notNull(),
	action: text().notNull(),
	comment: text(),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_review_actions_actor").using("btree", table.actorUserId.asc().nullsLast().op("uuid_ops")),
	index("ix_review_actions_revision").using("btree", table.revisionId.asc().nullsLast().op("timestamptz_ops"), table.at.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "review_actions_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.actorUserId],
			foreignColumns: [users.id],
			name: "review_actions_actor_user_id_fkey"
		}),
	check("review_actions_action_chk", sql`action ~ '^[a-z][a-z0-9_]*$'::text`),
]);

export const appSettings = pgTable("app_settings", {
	key: text().primaryKey().notNull(),
	value: jsonb().notNull(),
	updatedBy: uuid("updated_by"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_app_settings_updated_by").using("btree", table.updatedBy.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.updatedBy],
			foreignColumns: [users.id],
			name: "app_settings_updated_by_fkey"
		}),
]);

export const promptTemplates = pgTable("prompt_templates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code: text().notNull(),
	version: integer().notNull(),
	stage: text().notNull(),
	docTypeCode: text("doc_type_code"),
	state: text().default('draft').notNull(),
	systemPrompt: text("system_prompt").notNull(),
	userTemplate: text("user_template").notNull(),
	outputSchema: jsonb("output_schema"),
	modelOverride: text("model_override"),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
	publishedBy: uuid("published_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_prompt_templates_doc_type").using("btree", table.docTypeCode.asc().nullsLast().op("text_ops")),
	index("ix_prompt_templates_published_by").using("btree", table.publishedBy.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_prompt_templates_single_published").using("btree", table.code.asc().nullsLast().op("text_ops")).where(sql`(state = 'published'::text)`),
	foreignKey({
			columns: [table.docTypeCode],
			foreignColumns: [docTypes.code],
			name: "prompt_templates_doc_type_code_fkey"
		}),
	foreignKey({
			columns: [table.publishedBy],
			foreignColumns: [users.id],
			name: "prompt_templates_published_by_fkey"
		}),
	unique("prompt_templates_code_version_uq").on(table.code, table.version),
	check("prompt_templates_code_chk", sql`code ~ '^[a-z][a-z0-9_]*$'::text`),
	check("prompt_templates_version_chk", sql`version > 0`),
	check("prompt_templates_state_chk", sql`state = ANY (ARRAY['draft'::text, 'test'::text, 'published'::text, 'archived'::text])`),
	check("prompt_templates_published_chk", sql`(state <> 'published'::text) OR ((published_at IS NOT NULL) AND (published_by IS NOT NULL))`),
	check("prompt_templates_stage_chk", sql`stage = ANY (ARRAY['page_classify'::text, 'doc_split'::text, 'extract'::text, 'check'::text, 'summary'::text, 'recognize'::text])`),
]);

export const jobs = pgTable("jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	type: text().notNull(),
	payload: jsonb().default({}).notNull(),
	status: text().default('queued').notNull(),
	attempts: integer().default(0).notNull(),
	maxAttempts: integer("max_attempts").default(5).notNull(),
	nextRunAt: timestamp("next_run_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lockedBy: text("locked_by"),
	lockedUntil: timestamp("locked_until", { withTimezone: true, mode: 'string' }),
	lastError: text("last_error"),
	priority: integer().default(100).notNull(),
	dedupeKey: text("dedupe_key"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_jobs_claim").using("btree", table.priority.desc().nullsFirst().op("int4_ops"), table.nextRunAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'queued'::text)`),
	index("ix_jobs_lease").using("btree", table.lockedUntil.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'running'::text)`),
	index("ix_jobs_status_next_run").using("btree", table.status.asc().nullsLast().op("timestamptz_ops"), table.nextRunAt.asc().nullsLast().op("timestamptz_ops")),
	uniqueIndex("ux_jobs_dedupe_key").using("btree", table.dedupeKey.asc().nullsLast().op("text_ops")).where(sql`((dedupe_key IS NOT NULL) AND (status <> 'done'::text))`),
	check("jobs_type_chk", sql`type ~ '^[a-z][a-z0-9_]*([.][a-z0-9_]+)*$'::text`),
	check("jobs_status_chk", sql`status = ANY (ARRAY['queued'::text, 'running'::text, 'done'::text, 'failed'::text, 'cancelled'::text])`),
	check("jobs_attempts_chk", sql`attempts >= 0`),
	check("jobs_max_attempts_chk", sql`max_attempts > 0`),
]);

export const jobRuns = pgTable("job_runs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	jobId: uuid("job_id"),
	jobType: text("job_type").notNull(),
	revisionId: uuid("revision_id"),
	requestId: text("request_id"),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	finishedAt: timestamp("finished_at", { withTimezone: true, mode: 'string' }),
	durationMs: integer("duration_ms"),
	attempt: integer().notNull(),
	outcome: text(),
	errorClass: text("error_class"),
	errorMessage: text("error_message"),
	payloadDigest: text("payload_digest"),
}, (table) => [
	index("ix_job_runs_in_flight").using("btree", table.startedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(outcome IS NULL)`),
	index("ix_job_runs_job").using("btree", table.jobId.asc().nullsLast().op("uuid_ops")),
	index("ix_job_runs_request").using("btree", table.requestId.asc().nullsLast().op("text_ops")),
	index("ix_job_runs_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops"), table.startedAt.desc().nullsFirst().op("uuid_ops")),
	index("ix_job_runs_type").using("btree", table.jobType.asc().nullsLast().op("text_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	foreignKey({
			columns: [table.jobId],
			foreignColumns: [jobs.id],
			name: "job_runs_job_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "job_runs_revision_id_fkey"
		}),
	check("job_runs_attempt_chk", sql`attempt > 0`),
	check("job_runs_outcome_chk", sql`(outcome IS NULL) OR (outcome = ANY (ARRAY['succeeded'::text, 'failed'::text, 'cancelled'::text, 'lease_expired'::text]))`),
	check("job_runs_duration_chk", sql`(duration_ms IS NULL) OR (duration_ms >= 0)`),
	check("job_runs_finished_chk", sql`(outcome IS NOT NULL) OR (finished_at IS NULL)`),
]);

export const errorEvents = pgTable("error_events", {
	fingerprint: text().primaryKey().notNull(),
	errorClass: text("error_class").notNull(),
	messageTemplate: text("message_template").notNull(),
	topFrame: text("top_frame"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	count: bigint({ mode: "number" }).default(1).notNull(),
	firstSeenAt: timestamp("first_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sampleRequestId: text("sample_request_id"),
	sampleContext: jsonb("sample_context"),
	status: text().default('new').notNull(),
	ackedBy: uuid("acked_by"),
	resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_error_events_acked_by").using("btree", table.ackedBy.asc().nullsLast().op("uuid_ops")),
	index("ix_error_events_status").using("btree", table.status.asc().nullsLast().op("text_ops"), table.lastSeenAt.desc().nullsFirst().op("text_ops")),
	foreignKey({
			columns: [table.ackedBy],
			foreignColumns: [users.id],
			name: "error_events_acked_by_fkey"
		}),
	check("error_events_count_chk", sql`count > 0`),
	check("error_events_status_chk", sql`status = ANY (ARRAY['new'::text, 'ack'::text, 'resolved'::text])`),
]);

export const outbox = pgTable("outbox", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "outbox_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	aggregateType: text("aggregate_type").notNull(),
	aggregateId: uuid("aggregate_id").notNull(),
	eventType: text("event_type").notNull(),
	payload: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ix_outbox_aggregate").using("btree", table.aggregateType.asc().nullsLast().op("text_ops"), table.aggregateId.asc().nullsLast().op("text_ops")),
	index("ix_outbox_unpublished").using("btree", table.id.asc().nullsLast().op("int8_ops")).where(sql`(published_at IS NULL)`),
]);

export const layoutProfiles = pgTable("layout_profiles", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	code: text().notNull(),
	version: integer().notNull(),
	effectiveFrom: date("effective_from").notNull(),
	effectiveTo: date("effective_to"),
	thresholds: jsonb().notNull(),
	notes: text(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	publishedBy: uuid("published_by"),
}, (table) => [
	index("ix_layout_profiles_published_by").using("btree", table.publishedBy.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_layout_profiles_open").using("btree", table.code.asc().nullsLast().op("text_ops")).where(sql`(effective_to IS NULL)`),
	foreignKey({
			columns: [table.publishedBy],
			foreignColumns: [users.id],
			name: "layout_profiles_published_by_fkey"
		}),
	unique("layout_profiles_code_version_uq").on(table.code, table.version),
	check("layout_profiles_code_chk", sql`code ~ '^[a-z][a-z0-9_]{0,63}$'::text`),
	check("layout_profiles_version_chk", sql`version > 0`),
	check("layout_profiles_thresholds_chk", sql`jsonb_typeof(thresholds) = 'object'::text`),
	check("layout_profiles_period_chk", sql`(effective_to IS NULL) OR (effective_to > effective_from)`),
]);

export const logicalDocuments = pgTable("logical_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	objectId: uuid("object_id").notNull(),
	contractorId: uuid("contractor_id").notNull(),
	docTypeCode: text("doc_type_code"),
	ordinal: integer().notNull(),
	title: text(),
	folderGroup: text("folder_group"),
	typeConfidence: doublePrecision("type_confidence"),
	boundaryConfidence: doublePrecision("boundary_confidence"),
	needsReview: boolean("needs_review").default(false).notNull(),
	isConfirmed: boolean("is_confirmed").default(false).notNull(),
	confirmedBy: uuid("confirmed_by"),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: 'string' }),
	derivedPdfBlobSha256: text("derived_pdf_blob_sha256"),
	isDerivedCopy: boolean("is_derived_copy").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	version: integer().default(0).notNull(),
	derivedPdfPageCount: integer("derived_pdf_page_count"),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	derivedPdfBytes: bigint("derived_pdf_bytes", { mode: "number" }),
	derivedPdfBuiltAt: timestamp("derived_pdf_built_at", { withTimezone: true, mode: 'string' }),
	derivedPdfToolkit: text("derived_pdf_toolkit"),
	derivedNoteApplied: boolean("derived_note_applied"),
}, (table) => [
	index("ix_logical_documents_confirmed_by").using("btree", table.confirmedBy.asc().nullsLast().op("uuid_ops")),
	index("ix_logical_documents_contractor").using("btree", table.contractorId.asc().nullsLast().op("uuid_ops")),
	index("ix_logical_documents_doc_type").using("btree", table.docTypeCode.asc().nullsLast().op("text_ops")),
	index("ix_logical_documents_needs_review").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")).where(sql`needs_review`),
	index("ix_logical_documents_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	index("ix_logical_documents_revision").using("btree", table.revisionId.asc().nullsLast().op("int4_ops"), table.ordinal.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "logical_documents_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.docTypeCode],
			foreignColumns: [docTypes.code],
			name: "logical_documents_doc_type_code_fkey"
		}),
	foreignKey({
			columns: [table.confirmedBy],
			foreignColumns: [users.id],
			name: "logical_documents_confirmed_by_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.objectId, table.contractorId],
			foreignColumns: [submissionRevisions.contractorId, submissionRevisions.id, submissionRevisions.objectId],
			name: "logical_documents_scope_fk"
		}),
	unique("logical_documents_revision_id_uq").on(table.id, table.revisionId),
	check("logical_documents_ordinal_chk", sql`ordinal >= 0`),
	check("logical_documents_type_confidence_chk", sql`(type_confidence IS NULL) OR ((type_confidence >= (0)::double precision) AND (type_confidence <= (1)::double precision))`),
	check("logical_documents_boundary_confidence_chk", sql`(boundary_confidence IS NULL) OR ((boundary_confidence >= (0)::double precision) AND (boundary_confidence <= (1)::double precision))`),
	check("logical_documents_confirmed_chk", sql`(NOT is_confirmed) OR (confirmed_by IS NOT NULL)`),
	check("logical_documents_derived_pdf_chk", sql`derived_pdf_blob_sha256 ~ '^[0-9a-f]{64}$'::text`),
	check("logical_documents_version_chk", sql`version >= 0`),
	check("logical_documents_derived_marked_chk", sql`(derived_pdf_blob_sha256 IS NULL) OR is_derived_copy`),
	check("logical_documents_derived_confirmed_chk", sql`(derived_pdf_blob_sha256 IS NULL) OR is_confirmed`),
	check("logical_documents_derived_provenance_chk", sql`((derived_pdf_blob_sha256 IS NULL) AND (derived_pdf_page_count IS NULL) AND (derived_pdf_bytes IS NULL) AND (derived_pdf_built_at IS NULL) AND (derived_pdf_toolkit IS NULL) AND (derived_note_applied IS NULL)) OR ((derived_pdf_blob_sha256 IS NOT NULL) AND (derived_pdf_page_count IS NOT NULL) AND (derived_pdf_bytes IS NOT NULL) AND (derived_pdf_built_at IS NOT NULL) AND (derived_pdf_toolkit IS NOT NULL) AND (derived_note_applied IS NOT NULL))`),
	check("logical_documents_derived_sizes_chk", sql`((derived_pdf_page_count IS NULL) OR (derived_pdf_page_count > 0)) AND ((derived_pdf_bytes IS NULL) OR (derived_pdf_bytes > 0))`),
]);

export const submissionArchives = pgTable("submission_archives", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	objectId: uuid("object_id").notNull(),
	contractorId: uuid("contractor_id").notNull(),
	s3Key: text("s3_key").notNull(),
	archiveSha256: text("archive_sha256").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	byteSize: bigint("byte_size", { mode: "number" }).notNull(),
	entryCount: integer("entry_count").notNull(),
	builderVersion: text("builder_version").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_submission_archives_contractor").using("btree", table.contractorId.asc().nullsLast().op("uuid_ops")),
	index("ix_submission_archives_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "submission_archives_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.objectId, table.contractorId],
			foreignColumns: [submissionRevisions.contractorId, submissionRevisions.id, submissionRevisions.objectId],
			name: "submission_archives_scope_fk"
		}),
	unique("submission_archives_revision_id_key").on(table.revisionId),
	unique("submission_archives_s3_key_key").on(table.s3Key),
	check("submission_archives_sha_chk", sql`archive_sha256 ~ '^[0-9a-f]{64}$'::text`),
	check("submission_archives_size_chk", sql`byte_size > 0`),
	check("submission_archives_entries_chk", sql`entry_count > 0`),
]);

export const legalHolds = pgTable("legal_holds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	revisionId: uuid("revision_id").notNull(),
	objectId: uuid("object_id").notNull(),
	reason: text().notNull(),
	placedBy: uuid("placed_by").notNull(),
	placedAt: timestamp("placed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	releasedBy: uuid("released_by"),
	releasedAt: timestamp("released_at", { withTimezone: true, mode: 'string' }),
	releaseNote: text("release_note"),
}, (table) => [
	index("ix_legal_holds_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	index("ix_legal_holds_placed_by").using("btree", table.placedBy.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("ux_legal_holds_active").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")).where(sql`(released_at IS NULL)`),
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "legal_holds_revision_id_fkey"
		}),
	foreignKey({
			columns: [table.placedBy],
			foreignColumns: [users.id],
			name: "legal_holds_placed_by_fkey"
		}),
	foreignKey({
			columns: [table.releasedBy],
			foreignColumns: [users.id],
			name: "legal_holds_released_by_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.objectId],
			foreignColumns: [submissionRevisions.id, submissionRevisions.objectId],
			name: "legal_holds_object_fk"
		}),
	check("legal_holds_reason_chk", sql`length(btrim(reason)) >= 10`),
	check("legal_holds_release_chk", sql`(released_by IS NULL) = (released_at IS NULL)`),
]);

export const userRoles = pgTable("user_roles", {
	userId: uuid("user_id").notNull(),
	role: text().notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_roles_user_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.role, table.userId], name: "user_roles_pkey"}),
	check("user_roles_role_chk", sql`role = ANY (ARRAY['contractor'::text, 'engineer'::text, 'manager'::text, 'admin'::text])`),
]);

export const userObjectScopes = pgTable("user_object_scopes", {
	userId: uuid("user_id").notNull(),
	objectId: uuid("object_id").notNull(),
	grantedAt: timestamp("granted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_user_object_scopes_object").using("btree", table.objectId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [users.id],
			name: "user_object_scopes_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.objectId],
			foreignColumns: [constructionObjects.id],
			name: "user_object_scopes_object_fk"
		}),
	primaryKey({ columns: [table.objectId, table.userId], name: "user_object_scopes_pkey"}),
]);

export const processingBundlePages = pgTable("processing_bundle_pages", {
	bundleId: uuid("bundle_id").notNull(),
	revisionId: uuid("revision_id").notNull(),
	workingPageIndex: integer("working_page_index").notNull(),
	sourcePageId: uuid("source_page_id").notNull(),
}, (table) => [
	index("ix_processing_bundle_pages_page").using("btree", table.sourcePageId.asc().nullsLast().op("uuid_ops")),
	index("ix_processing_bundle_pages_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.bundleId],
			foreignColumns: [processingBundles.id],
			name: "processing_bundle_pages_bundle_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.sourcePageId],
			foreignColumns: [sourcePages.id],
			name: "processing_bundle_pages_source_page_id_fkey"
		}),
	foreignKey({
			columns: [table.bundleId, table.revisionId],
			foreignColumns: [processingBundles.id, processingBundles.revisionId],
			name: "processing_bundle_pages_bundle_fk"
		}),
	foreignKey({
			columns: [table.revisionId, table.sourcePageId],
			foreignColumns: [sourcePages.id, sourcePages.revisionId],
			name: "processing_bundle_pages_page_fk"
		}),
	primaryKey({ columns: [table.bundleId, table.workingPageIndex], name: "processing_bundle_pages_pkey"}),
	unique("processing_bundle_pages_page_uq").on(table.bundleId, table.sourcePageId),
	unique("processing_bundle_pages_page_index_uq").on(table.bundleId, table.sourcePageId, table.workingPageIndex),
	check("processing_bundle_pages_index_chk", sql`working_page_index >= 0`),
]);

export const layoutBlockPoints = pgTable("layout_block_points", {
	blockId: uuid("block_id").notNull(),
	pointNo: integer("point_no").notNull(),
	x: doublePrecision().notNull(),
	y: doublePrecision().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.blockId],
			foreignColumns: [layoutBlocks.id],
			name: "layout_block_points_block_id_fkey"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.blockId, table.pointNo], name: "layout_block_points_pkey"}),
	check("layout_block_points_point_no_chk", sql`point_no >= 0`),
	check("layout_block_points_x_chk", sql`(x >= (0)::double precision) AND (x <= (1)::double precision)`),
	check("layout_block_points_y_chk", sql`(y >= (0)::double precision) AND (y <= (1)::double precision)`),
]);

export const findingEvidence = pgTable("finding_evidence", {
	findingId: uuid("finding_id").notNull(),
	pageTextVersionId: uuid("page_text_version_id").notNull(),
	charSpan: int4range("char_span").notNull(),
	quote: text().notNull(),
}, (table) => [
	index("ix_finding_evidence_page_text").using("btree", table.pageTextVersionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.findingId],
			foreignColumns: [findings.id],
			name: "finding_evidence_finding_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.pageTextVersionId],
			foreignColumns: [pageTextVersions.id],
			name: "finding_evidence_page_text_version_id_fkey"
		}),
	primaryKey({ columns: [table.charSpan, table.findingId, table.pageTextVersionId], name: "finding_evidence_pkey"}),
	check("finding_evidence_span_chk", sql`lower(char_span) >= 0`),
]);

export const documentRelations = pgTable("document_relations", {
	parentDocumentId: uuid("parent_document_id").notNull(),
	childDocumentId: uuid("child_document_id").notNull(),
	relation: text().notNull(),
	revisionId: uuid("revision_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_document_relations_child").using("btree", table.childDocumentId.asc().nullsLast().op("uuid_ops")),
	index("ix_document_relations_revision").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.parentDocumentId, table.revisionId],
			foreignColumns: [logicalDocuments.id, logicalDocuments.revisionId],
			name: "document_relations_parent_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.childDocumentId, table.revisionId],
			foreignColumns: [logicalDocuments.id, logicalDocuments.revisionId],
			name: "document_relations_child_fk"
		}).onDelete("cascade"),
	primaryKey({ columns: [table.childDocumentId, table.parentDocumentId, table.relation], name: "document_relations_pkey"}),
	check("document_relations_self_chk", sql`parent_document_id <> child_document_id`),
	check("document_relations_relation_chk", sql`relation = ANY (ARRAY['annex'::text, 'quality_doc'::text, 'protocol'::text, 'copy_certification'::text, 'signature_page'::text, 'supersedes'::text, 'duplicate'::text])`),
]);

export const revisionEvents = pgTable("revision_events", {
	revisionId: uuid("revision_id").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	seq: bigint({ mode: "number" }).notNull(),
	eventType: text("event_type").notNull(),
	payload: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.revisionId],
			foreignColumns: [submissionRevisions.id],
			name: "revision_events_revision_id_fkey"
		}),
	primaryKey({ columns: [table.revisionId, table.seq], name: "revision_events_pkey"}),
	check("revision_events_seq_chk", sql`seq > 0`),
]);

export const rulesetRules = pgTable("ruleset_rules", {
	rulesetVersionId: uuid("ruleset_version_id").notNull(),
	ruleCode: text("rule_code").notNull(),
	isEnabled: boolean("is_enabled").default(true).notNull(),
	severity: text().notNull(),
	isBlocking: boolean("is_blocking").default(false).notNull(),
	params: jsonb().default({}).notNull(),
}, (table) => [
	index("ix_ruleset_rules_rule").using("btree", table.ruleCode.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.rulesetVersionId],
			foreignColumns: [rulesetVersions.id],
			name: "ruleset_rules_ruleset_version_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.ruleCode],
			foreignColumns: [ruleDefinitions.code],
			name: "ruleset_rules_rule_code_fkey"
		}),
	primaryKey({ columns: [table.ruleCode, table.rulesetVersionId], name: "ruleset_rules_pkey"}),
	check("ruleset_rules_severity_chk", sql`severity = ANY (ARRAY['error'::text, 'warning'::text, 'info'::text])`),
]);

export const recognitionRunPages = pgTable("recognition_run_pages", {
	recognitionRunId: uuid("recognition_run_id").notNull(),
	workingPageIndex: integer("working_page_index").notNull(),
	status: text().default('pending').notNull(),
	blocksTotal: integer("blocks_total").default(0).notNull(),
	blocksRecognized: integer("blocks_recognized").default(0).notNull(),
	blocksInvalid: integer("blocks_invalid").default(0).notNull(),
	blocksRefused: integer("blocks_refused").default(0).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.recognitionRunId],
			foreignColumns: [recognitionRuns.id],
			name: "recognition_run_pages_recognition_run_id_fkey"
		}),
	primaryKey({ columns: [table.recognitionRunId, table.workingPageIndex], name: "recognition_run_pages_pkey"}),
	check("recognition_run_pages_page_chk", sql`working_page_index >= 0`),
	check("recognition_run_pages_status_chk", sql`status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text])`),
	check("recognition_run_pages_counts_chk", sql`(blocks_total >= 0) AND (blocks_recognized >= 0) AND (blocks_invalid >= 0) AND (blocks_refused >= 0)`),
]);

export const pageClassifications = pgTable("page_classifications", {
	revisionId: uuid("revision_id").notNull(),
	sourcePageId: uuid("source_page_id").notNull(),
	label: text().notNull(),
	docTypeCode: text("doc_type_code"),
	typeOutcome: text("type_outcome").notNull(),
	observedTitle: text("observed_title"),
	pageRoleCode: text("page_role_code"),
	parentRef: text("parent_ref"),
	confidence: doublePrecision(),
	reason: text(),
	source: text().notNull(),
	pageTextVersionId: uuid("page_text_version_id"),
	charSpan: int4range("char_span"),
	quote: text(),
	alternatives: jsonb().default([]).notNull(),
	ambiguous: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ix_page_classifications_doc_type").using("btree", table.docTypeCode.asc().nullsLast().op("text_ops")),
	index("ix_page_classifications_other").using("btree", table.revisionId.asc().nullsLast().op("uuid_ops")).where(sql`(type_outcome = 'other'::text)`),
	index("ix_page_classifications_page_text").using("btree", table.pageTextVersionId.asc().nullsLast().op("uuid_ops")),
	index("ix_page_classifications_role").using("btree", table.pageRoleCode.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.docTypeCode],
			foreignColumns: [docTypes.code],
			name: "page_classifications_doc_type_code_fkey"
		}),
	foreignKey({
			columns: [table.pageRoleCode],
			foreignColumns: [pageRoles.code],
			name: "page_classifications_page_role_code_fkey"
		}),
	foreignKey({
			columns: [table.revisionId, table.sourcePageId],
			foreignColumns: [sourcePages.id, sourcePages.revisionId],
			name: "page_classifications_source_page_fk"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.revisionId, table.pageTextVersionId],
			foreignColumns: [pageTextVersions.id, pageTextVersions.revisionId],
			name: "page_classifications_page_text_fk"
		}),
	primaryKey({ columns: [table.revisionId, table.sourcePageId], name: "page_classifications_pkey"}),
	check("page_classifications_label_chk", sql`label = ANY (ARRAY['B-DOC'::text, 'I-DOC'::text, 'A-ROLE'::text, 'U'::text])`),
	check("page_classifications_type_outcome_chk", sql`type_outcome = ANY (ARRAY['known'::text, 'other'::text, 'uncertain'::text, 'none'::text])`),
	check("page_classifications_source_chk", sql`source = ANY (ARRAY['anchor'::text, 'blocks'::text, 'llm'::text, 'manual'::text])`),
	check("page_classifications_confidence_chk", sql`(confidence IS NULL) OR ((confidence >= (0)::double precision) AND (confidence <= (1)::double precision))`),
	check("page_classifications_observed_title_chk", sql`(type_outcome <> 'other'::text) OR ((observed_title IS NOT NULL) AND (btrim(observed_title) <> ''::text))`),
	check("page_classifications_known_type_chk", sql`(type_outcome <> 'known'::text) OR (doc_type_code IS NOT NULL)`),
	check("page_classifications_span_source_chk", sql`(char_span IS NULL) OR (page_text_version_id IS NOT NULL)`),
	check("page_classifications_span_bounds_chk", sql`(char_span IS NULL) OR (lower(char_span) >= 0)`),
	check("page_classifications_quote_span_chk", sql`(quote IS NULL) OR (char_span IS NOT NULL)`),
]);
export const vUnaccountedPages = pgView("v_unaccounted_pages", {	revisionId: uuid("revision_id"),
	sourcePageId: uuid("source_page_id"),
	sourceFileId: uuid("source_file_id"),
	revisionOrdinal: integer("revision_ordinal"),
}).as(sql`SELECT revision_id, id AS source_page_id, source_file_id, revision_ordinal FROM source_pages p WHERE NOT (EXISTS ( SELECT 1 FROM page_assignments a WHERE a.revision_id = p.revision_id AND a.source_page_id = p.id))`);