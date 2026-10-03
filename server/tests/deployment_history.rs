use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use vectory_server::{Settings, State, api, auth, db, initialize};

async fn actor(s: &State, role: &str) -> (String, String) {
    let id = db::id();
    let token = auth::random_secret();
    sqlx::query(
        "INSERT INTO users(id,email,name,role,password_hash,created_at) VALUES(?,?,?,?,?,?)",
    )
    .bind(&id)
    .bind(format!("{id}@example.test"))
    .bind(role)
    .bind(role)
    .bind("unused-test-hash")
    .bind(db::now())
    .execute(&s.pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO sessions VALUES(?,?,?,?)")
        .bind(db::hash(&token))
        .bind(&id)
        .bind(auth::random_secret())
        .bind("2099-01-01T00:00:00Z")
        .execute(&s.pool)
        .await
        .unwrap();
    (id, format!("vectory_session={token}"))
}
async fn fixture() -> (tempfile::TempDir, State, Router, String) {
    let temp = tempfile::tempdir().unwrap();
    let s = initialize(Settings {
        data_dir: temp.path().join("state"),
        bootstrap_secret: "unused-test-bootstrap-secret".into(),
        cookie_secure: false,
        dashboard_dir: temp.path().join("dist"),
        releases_dir: temp.path().join("releases"),
        instance_name: "Deployment history tests".into(),
        validation_url: None,
        ..Default::default()
    })
    .await
    .unwrap();
    let (_, cookie) = actor(&s, "admin").await;
    (temp, s.clone(), api::router(s), cookie)
}
async fn get(app: &Router, path: &str, cookie: Option<&str>) -> (StatusCode, Value) {
    let mut request = Request::builder().uri(path);
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = app
        .clone()
        .oneshot(request.body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = response.status();
    assert_eq!(response.headers()["x-content-type-options"], "nosniff");
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}
fn deployment(id: &str) -> Value {
    json!({"id":id,"created_at":"2026-01-01T00:00:00Z","status":"active","version_id":"v","priority":1,"target_mode":"snapshot","rollout":{"kind":"all","canary_size":1,"batch_size":10,"observation_seconds":0,"failure_threshold":0},"selector":{"device_ids":[],"group_ids":[],"exclude_ids":[]}})
}
async fn insert(s: &State, kind: &str, v: &Value) {
    let mut conn = s.pool.acquire().await.unwrap();
    db::insert(&mut conn, kind, v).await.unwrap();
}

#[tokio::test]
async fn authenticated_strict_bounded_queries_and_offboarding() {
    let (_temp, s, app, _) = fixture().await;
    insert(&s, "deployment", &deployment("one")).await;
    for path in [
        "/api/v1/deployments/history",
        "/api/v1/deployments/one/summary",
        "/api/v1/deployments/one/targets",
        "/api/v1/deployments/absent/targets?unknown=private",
    ] {
        assert_eq!(get(&app, path, None).await.0, StatusCode::UNAUTHORIZED);
    }
    for role in ["viewer", "editor", "operator", "admin"] {
        let (id, cookie) = actor(&s, role).await;
        for path in [
            "/api/v1/deployments/history",
            "/api/v1/deployments/one/summary",
            "/api/v1/deployments/one/targets",
        ] {
            assert_eq!(get(&app, path, Some(&cookie)).await.0, StatusCode::OK);
            for query in [
                "unknown=RAW_QUERY_SECRET",
                "unknown=one&unknown=two",
                "search=%FF",
                "search=%",
                "search=%GG",
            ] {
                let (status, value) = get(&app, &format!("{path}?{query}"), Some(&cookie)).await;
                assert_eq!(status, StatusCode::BAD_REQUEST, "{path} {query}: {value}");
                assert_eq!(value["error"]["code"], "INVALID_INPUT");
                assert!(!value.to_string().contains("RAW_QUERY_SECRET"));
            }
        }
        for path in [
            "/api/v1/deployments/history",
            "/api/v1/deployments/one/targets",
        ] {
            for query in [
                "page=0",
                "page=-1",
                "page=1.5",
                "page_size=51",
                "page_size=0",
                "page=9007199254740992",
                "page=18446744073709551615",
                "page=1&page=2",
                "search=a&search=b",
            ] {
                assert_eq!(
                    get(&app, &format!("{path}?{query}"), Some(&cookie)).await.0,
                    StatusCode::BAD_REQUEST,
                    "{path} {query}"
                );
            }
            for (n, expected) in [(200, StatusCode::OK), (201, StatusCode::BAD_REQUEST)] {
                let path = format!("{path}?search={}", "%F0%9F%8C%90".repeat(n));
                assert_eq!(get(&app, &path, Some(&cookie)).await.0, expected);
            }
        }
        for query in [
            "status=invalid",
            "scheduled=1",
            "scheduled=True",
            "scheduled=true&scheduled=false",
        ] {
            assert_eq!(
                get(
                    &app,
                    &format!("/api/v1/deployments/history?{query}"),
                    Some(&cookie)
                )
                .await
                .0,
                StatusCode::BAD_REQUEST
            );
        }
        assert_eq!(
            get(
                &app,
                "/api/v1/deployments/one/targets?state=bad%20state",
                Some(&cookie)
            )
            .await
            .0,
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            get(&app, "/api/v1/deployments/missing/summary", Some(&cookie))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            get(&app, "/api/v1/deployments/missing/targets", Some(&cookie))
                .await
                .0,
            StatusCode::NOT_FOUND
        );
        sqlx::query("UPDATE users SET enabled=0 WHERE id=?")
            .bind(id)
            .execute(&s.pool)
            .await
            .unwrap();
        assert_eq!(
            get(&app, "/api/v1/deployments/history", Some(&cookie))
                .await
                .0,
            StatusCode::UNAUTHORIZED
        );
    }
}

#[tokio::test]
async fn history_projects_more_than_200_versions_with_literal_metadata_only_search() {
    let (_temp, s, app, cookie) = fixture().await;
    let payload = "PRIVATE_BODY_NOT_SEARCHABLE".repeat(1400);
    let mut tx = s.pool.begin().await.unwrap();
    for n in 1..=1000 {
        let id = format!("d{n:04}");
        let version = format!("v{n:04}");
        let config = format!("c{n:04}");
        db::insert(&mut tx,"configuration",&json!({"id":config,"name":format!("Pipeline {n:04}"),"config":{"payload":payload},"graph":{"payload":payload}})).await.unwrap();
        db::insert(&mut tx,"version",&json!({"id":version,"configuration_id":config,"number":n,"artifact":payload,"config":{"payload":payload},"graph":{"payload":payload}})).await.unwrap();
        let mut d = deployment(&id);
        d["version_id"] = json!(version);
        d["selector"]["device_ids"] = json!([payload]);
        d["rollout"]["opaque"] = json!(payload);
        d["opaque"] = json!(payload);
        if n % 2 == 0 {
            d["scheduled_at"] = json!("2020-01-01T00:00:00Z");
            d["status"] = json!(if n % 4 == 0 { "missed" } else { "cancelled" });
        }
        if n == 999 {
            d["name"] = json!("Literal 100%_ [test] ' OR 1=1 --");
        }
        db::insert(&mut tx, "deployment", &d).await.unwrap();
    }
    tx.commit().await.unwrap();
    let (_, page) = get(&app, "/api/v1/deployments/history?page=21", Some(&cookie)).await;
    assert_eq!(page["total"], 1000);
    assert_eq!(page["page"], 21);
    assert_eq!(page["page_size"], 12);
    assert_eq!(page["items"][0]["id"], "d0241");
    assert_eq!(page["items"][0]["version_number"], 241);
    assert_eq!(page["items"][0]["configuration_name"], "Pipeline 0241");
    assert!(page.to_string().len() < 12000);
    assert!(!page.to_string().contains("PRIVATE_BODY"));
    for item in page["items"].as_array().unwrap() {
        assert_eq!(item["target_count"], 0);
        assert_eq!(item["verified_count"], 0);
        assert_eq!(item["state_counts"], json!({}));
        for key in [
            "selector", "targets", "artifact", "config", "graph", "opaque",
        ] {
            assert!(item.get(key).is_none());
        }
        let (_, detail) = get(
            &app,
            &format!(
                "/api/v1/deployments/{}/summary",
                item["id"].as_str().unwrap()
            ),
            Some(&cookie),
        )
        .await;
        assert_eq!(&detail, item);
    }
    for (query, total) in [
        ("scheduled=true", 500),
        ("scheduled=false", 500),
        ("status=missed", 250),
        ("status=active&scheduled=true", 0),
        ("search=PRIVATE_BODY_NOT_SEARCHABLE", 0),
        ("search=Pipeline%200241", 1),
        ("search=Version%20241", 1),
        ("search=100%25_%20%5Btest%5D", 1),
        ("search=%27%20OR%201%3D1%20--", 1),
        ("page=1000", 1000),
    ] {
        let (_, page) = get(
            &app,
            &format!("/api/v1/deployments/history?{query}"),
            Some(&cookie),
        )
        .await;
        assert_eq!(page["total"], total, "{query}: {page}");
        if query == "page=1000" {
            assert_eq!(page["items"], json!([]));
        }
    }
    let (_, legacy) = get(&app, "/api/v1/deployments/d0241", Some(&cookie)).await;
    assert!(legacy["selector"].is_object());
    assert!(legacy["targets"].is_array());
}

#[tokio::test]
async fn policy_and_missing_metadata_are_explicit_without_raw_extensions() {
    let (_temp, s, app, cookie) = fixture().await;
    let mut d = deployment("policy");
    d.as_object_mut().unwrap().remove("version_id");
    d["policy"] = json!({"heartbeat_seconds":60,"sync_paused":true,"telemetry_enabled":false,"private":"HIDDEN_POLICY"});
    insert(&s, "deployment", &d).await;
    // Deployment records historically preserve arbitrary request extensions.
    // Malformed unused names/IDs must not poison a typed metadata page or turn
    // a hidden object into searchable text.
    let mut malformed = d.clone();
    malformed["id"] = json!("legacy-extensions");
    malformed["name"] = json!({"opaque":"HIDDEN_NAME"});
    malformed["version_id"] = json!(42);
    insert(&s, "deployment", &malformed).await;
    let (_, legacy) = get(
        &app,
        "/api/v1/deployments/legacy-extensions/summary",
        Some(&cookie),
    )
    .await;
    assert!(legacy["name"].is_null());
    assert!(legacy["version_id"].is_null());
    assert_eq!(
        get(
            &app,
            "/api/v1/deployments/history?search=HIDDEN_NAME",
            Some(&cookie)
        )
        .await
        .1["total"],
        0
    );
    insert(&s, "deployment", &deployment("missing-version")).await;
    insert(
        &s,
        "version",
        &json!({"id":"v-without-parent","configuration_id":"retired-pipeline","number":42}),
    )
    .await;
    d = deployment("missing-parent");
    d["version_id"] = json!("v-without-parent");
    insert(&s, "deployment", &d).await;
    let (_, policy) = get(&app, "/api/v1/deployments/policy/summary", Some(&cookie)).await;
    assert_eq!(
        policy["policy"],
        json!({"heartbeat_seconds":60,"sync_paused":true,"telemetry_enabled":false})
    );
    assert!(policy["configuration_id"].is_null());
    assert!(policy["version_id"].is_null());
    let (_, page) = get(
        &app,
        "/api/v1/deployments/history?search=Agent%20settings%2060s%20heartbeat%20Sync%20paused",
        Some(&cookie),
    )
    .await;
    assert_eq!(page["total"], 2);
    assert!(page["items"].as_array().unwrap().contains(&policy));
    for search in [
        "Agent%20settings%2060s%20heartbeat%2C%20Sync%20paused",
        "60s%20heartbeat%2C%20Pause%20sync",
    ] {
        assert_eq!(
            get(
                &app,
                &format!("/api/v1/deployments/history?search={search}"),
                Some(&cookie)
            )
            .await
            .1["total"],
            2
        );
    }
    let mut literal = deployment("literal-comma-name");
    literal["name"] = json!("Literal, comma name");
    insert(&s, "deployment", &literal).await;
    assert_eq!(
        get(
            &app,
            "/api/v1/deployments/history?search=Literal%2C%20comma",
            Some(&cookie)
        )
        .await
        .1["total"],
        1
    );
    assert_eq!(
        get(
            &app,
            "/api/v1/deployments/history?search=Literal%20comma",
            Some(&cookie)
        )
        .await
        .1["total"],
        0
    );
    assert_eq!(
        get(
            &app,
            "/api/v1/deployments/history?search=HIDDEN_POLICY",
            Some(&cookie)
        )
        .await
        .1["total"],
        0
    );
    let (_, missing) = get(
        &app,
        "/api/v1/deployments/missing-version/summary",
        Some(&cookie),
    )
    .await;
    assert_eq!(missing["version_id"], "v");
    assert!(missing["version_number"].is_null());
    assert!(missing["configuration_name"].is_null());
    let (_, missing) = get(
        &app,
        "/api/v1/deployments/missing-parent/summary",
        Some(&cookie),
    )
    .await;
    assert_eq!(missing["configuration_id"], "retired-pipeline");
    assert_eq!(missing["version_number"], 42);
    assert!(missing["configuration_name"].is_null());
    let mut legacy_name = deployment("legacy-long-name");
    legacy_name["name"] = json!(format!("{}HIDDEN_NAME_SUFFIX", "🌐".repeat(120)));
    insert(&s, "deployment", &legacy_name).await;
    let (_, summary) = get(
        &app,
        "/api/v1/deployments/legacy-long-name/summary",
        Some(&cookie),
    )
    .await;
    assert_eq!(summary["name"], "🌐".repeat(120));
    assert_eq!(
        get(
            &app,
            "/api/v1/deployments/history?search=HIDDEN_NAME_SUFFIX",
            Some(&cookie)
        )
        .await
        .1["total"],
        0
    );
    assert_eq!(
        get(&app, "/api/v1/deployments/legacy-long-name", Some(&cookie))
            .await
            .1["name"],
        legacy_name["name"]
    );
}

#[test]
fn future_deployment_names_are_optional_nullable_and_bounded_without_changing_policy_or_version_requests()
 {
    use vectory_server::rollout::validate_request;
    let mut request = deployment("new");
    // A create request carries only client-controlled fields, not the stored
    // deployment's identity, lifecycle state or server timestamp.
    for field in ["id", "created_at", "status"] {
        request.as_object_mut().unwrap().remove(field);
    }
    for name in [Value::Null, json!(""), json!("🌐".repeat(120))] {
        request["name"] = name;
        assert!(validate_request(&request).is_ok());
    }
    for name in [
        json!(123),
        json!({"opaque":"text"}),
        json!(["text"]),
        json!("🌐".repeat(121)),
    ] {
        request["name"] = name;
        assert!(validate_request(&request).is_err());
    }
    request.as_object_mut().unwrap().remove("name");
    assert!(validate_request(&request).is_ok());
    request.as_object_mut().unwrap().remove("version_id");
    request["policy"] =
        json!({"heartbeat_seconds":60,"sync_paused":false,"telemetry_enabled":true});
    request["name"] = json!("A policy");
    assert!(validate_request(&request).is_ok());
    request["name"] = json!(true);
    assert!(validate_request(&request).is_err());
}

#[tokio::test]
async fn history_search_matches_visible_status_labels_and_keeps_raw_status_filter_exact() {
    let (_temp, s, app, cookie) = fixture().await;
    for (status, label) in [
        ("active", "In%20progress"),
        ("completed", "Complete"),
        ("failed", "Needs%20attention"),
        ("unassigned", "Removed"),
        ("missed", "Schedule%20missed"),
        ("paused", "Paused"),
    ] {
        let mut d = deployment(status);
        d["status"] = json!(status);
        insert(&s, "deployment", &d).await;
        let (_, page) = get(
            &app,
            &format!("/api/v1/deployments/history?search={label}&status={status}"),
            Some(&cookie),
        )
        .await;
        assert_eq!(page["total"], 1, "{label}: {page}");
        assert_eq!(page["items"][0]["id"], status);
    }
    assert_eq!(
        get(
            &app,
            "/api/v1/deployments/history?search=In%20progress&status=completed",
            Some(&cookie)
        )
        .await
        .1["total"],
        0
    );
}

#[tokio::test]
async fn targets_are_parent_bound_paged_and_counts_are_exact_persisted_states() {
    let (_temp, s, app, cookie) = fixture().await;
    insert(&s, "deployment", &deployment("one")).await;
    insert(&s, "deployment", &deployment("other")).await;
    let mut tx = s.pool.begin().await.unwrap();
    let states = [
        "verified_applied",
        "written",
        "failed",
        "verification_unknown",
        "rolled_back",
        "removed",
        "pending",
        "released",
        "incompatible",
        "future_state",
    ];
    for n in 0..1000 {
        let id = format!("device-{n:04}");
        let state = states[n % states.len()];
        sqlx::query("INSERT INTO devices(id,name,data,revoked) VALUES(?,?,?,?)")
            .bind(&id)
            .bind(format!("Device {n:04}"))
            .bind(
                json!({"name":"SPOOFED_NAME","status":"verified","secret":"PRIVATE_DEVICE"})
                    .to_string(),
            )
            .bind(n == 0)
            .execute(&mut *tx)
            .await
            .unwrap();
        sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation,error,original) VALUES('one',?,?,?,?,?)").bind(&id).bind(state).bind(n as i64).bind("PRIVATE_ERROR").bind(n%2==0).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state) VALUES('other',?,'verified_applied')").bind(id).execute(&mut *tx).await.unwrap();
    }
    tx.commit().await.unwrap();
    let before: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    let (_, summary) = get(&app, "/api/v1/deployments/one/summary", Some(&cookie)).await;
    assert_eq!(summary["target_count"], 1000);
    // The first device is revoked: its target keeps its stored state, but the
    // device no longer follows the deployment, so it reads as removed and
    // doesn't count as applied.
    assert_eq!(summary["verified_count"], 99);
    for state in states {
        let expected = match state {
            "verified_applied" => 99,
            "removed" => 101,
            _ => 100,
        };
        assert_eq!(summary["state_counts"][state], expected, "{state}");
    }
    assert_eq!(
        get(&app, "/api/v1/deployments/other/summary", Some(&cookie))
            .await
            .1["verified_count"],
        999
    );
    let (_, page) = get(
        &app,
        "/api/v1/deployments/one/targets?page=2",
        Some(&cookie),
    )
    .await;
    assert_eq!(page["total"], 1000);
    assert_eq!(page["items"].as_array().unwrap().len(), 12);
    assert_eq!(page["items"][0]["device_id"], "device-0012");
    assert_eq!(page["items"][0]["device_name"], "Device 0012");
    assert_eq!(page["items"][0]["original"], true);
    assert_eq!(page["items"][1]["original"], false);
    assert!(!page.to_string().contains("PRIVATE_DEVICE"));
    assert!(!page.to_string().contains("SPOOFED_NAME"));
    for (query, total) in [
        ("state=verified_applied", 99),
        ("state=removed", 101),
        ("state=future_state", 100),
        ("state=unknown_state", 0),
        ("search=Device%200012", 1),
        ("search=device-0012", 1),
        ("search=PRIVATE_ERROR", 0),
        ("search=PRIVATE_DEVICE", 0),
        ("state=removed&search=device-0012", 0),
    ] {
        let (_, page) = get(
            &app,
            &format!("/api/v1/deployments/one/targets?{query}"),
            Some(&cookie),
        )
        .await;
        assert_eq!(page["total"], total, "{query}: {page}");
    }
    // Revoked identities retain their own UUID-bound historical row; no name
    // substitution through JSON or matching replacement identities occurs.
    let (_, page) = get(
        &app,
        "/api/v1/deployments/one/targets?search=device-0000",
        Some(&cookie),
    )
    .await;
    assert_eq!(page["items"][0]["device_name"], "Device 0000");
    assert_eq!(page["items"][0]["generation"], 0);
    assert_eq!(page["items"][0]["state"], "removed");
    let stored: String = sqlx::query_scalar(
        "SELECT state FROM deployment_targets WHERE deployment_id='one' AND device_id='device-0000'",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(stored, "verified_applied", "the stored state is history");
    let after: i64 = sqlx::query_scalar("SELECT count(*) FROM records WHERE kind='audit'")
        .fetch_one(&s.pool)
        .await
        .unwrap();
    assert_eq!(before, after);
    // A legacy restored database can contain a dangling identity despite the
    // current FK restriction. The read path must expose null, never match names.
    let mut conn = s.pool.acquire().await.unwrap();
    sqlx::query("PRAGMA foreign_keys=OFF")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("DELETE FROM devices WHERE id='device-0000'")
        .execute(&mut *conn)
        .await
        .unwrap();
    sqlx::query("PRAGMA foreign_keys=ON")
        .execute(&mut *conn)
        .await
        .unwrap();
    drop(conn);
    let (_, page) = get(
        &app,
        "/api/v1/deployments/one/targets?search=device-0000",
        Some(&cookie),
    )
    .await;
    assert_eq!(page["total"], 1);
    assert!(page["items"][0]["device_name"].is_null());
}

/// A device that no longer follows a deployment reads "No longer targeted"
/// and doesn't count as applied: one that was revoked, and every device of an
/// assignment that was removed. The stored target states stay as history, and a
/// rollback keeps counting what applied before it.
#[tokio::test]
async fn devices_that_no_longer_follow_a_deployment_do_not_count_as_applied() {
    let (_temp, s, app, cookie) = fixture().await;
    for (id, status, extra) in [
        ("kept", "completed", json!({})),
        (
            "removed",
            "unassigned",
            json!({"status_before_removal":"completed"}),
        ),
        (
            "rolled-back",
            "unassigned",
            json!({"rolled_back_by":"replacement"}),
        ),
        ("live", "active", json!({})),
    ] {
        let mut record = deployment(id);
        record["status"] = json!(status);
        for (key, value) in extra.as_object().unwrap() {
            record[key] = value.clone();
        }
        insert(&s, "deployment", &record).await;
    }
    for (device, revoked) in [("device-a", false), ("device-b", false), ("device-c", true)] {
        sqlx::query("INSERT INTO devices(id,name,data,revoked) VALUES(?,?,'{}',?)")
            .bind(device)
            .bind(device)
            .bind(revoked)
            .execute(&s.pool)
            .await
            .unwrap();
        for deployment in ["kept", "removed", "rolled-back", "live"] {
            sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation) VALUES(?,?,'verified_applied',1)")
                .bind(deployment)
                .bind(device)
                .execute(&s.pool)
                .await
                .unwrap();
        }
    }
    let summary = |id: &'static str| {
        let app = app.clone();
        let cookie = cookie.clone();
        async move {
            get(
                &app,
                &format!("/api/v1/deployments/{id}/summary"),
                Some(&cookie),
            )
            .await
            .1
        }
    };
    // Revoked: kept in the rows, out of the count.
    let kept = summary("kept").await;
    assert_eq!(kept["target_count"], 3);
    assert_eq!(kept["verified_count"], 2);
    assert_eq!(
        kept["state_counts"],
        json!({"verified_applied":2,"removed":1})
    );
    // The assignment was removed: no device follows it any more.
    let removed = summary("removed").await;
    assert_eq!(removed["target_count"], 3);
    assert_eq!(removed["verified_count"], 0);
    assert_eq!(removed["state_counts"], json!({"removed":3}));
    // A rollback removes the assignment too, but its counts stay what applied
    // before the rollback.
    let rolled_back = summary("rolled-back").await;
    assert_eq!(rolled_back["verified_count"], 2);
    assert_eq!(
        rolled_back["state_counts"],
        json!({"verified_applied":2,"removed":1})
    );
    // Rows and their filters read the same way.
    for (deployment, query, total) in [
        ("kept", "state=verified_applied", 2),
        ("kept", "state=removed", 1),
        ("removed", "state=verified_applied", 0),
        ("removed", "state=removed", 3),
        ("rolled-back", "state=verified_applied", 2),
    ] {
        let (_, page) = get(
            &app,
            &format!("/api/v1/deployments/{deployment}/targets?{query}"),
            Some(&cookie),
        )
        .await;
        assert_eq!(page["total"], total, "{deployment} {query}");
    }
    let (_, rows) = get(
        &app,
        "/api/v1/deployments/removed/targets?sort=state",
        Some(&cookie),
    )
    .await;
    assert!(
        rows["items"]
            .as_array()
            .unwrap()
            .iter()
            .all(|row| row["state"] == "removed")
    );
    // The rollout page's lanes leave them out, as they do any removed row.
    let (_, lanes) = get(&app, "/api/v1/deployments/removed/rollout", Some(&cookie)).await;
    assert_eq!(lanes["removed_count"], 3);
    assert_eq!(lanes["stages"], json!([]));
    let (_, lanes) = get(&app, "/api/v1/deployments/kept/rollout", Some(&cookie)).await;
    assert_eq!(lanes["removed_count"], 1);
    let in_lanes: u64 = lanes["stages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|stage| stage["size"].as_u64().unwrap())
        .sum();
    assert_eq!(in_lanes, 2);
    // So does the Overview's progress of a rollout that is still running.
    let (_, overview) = get(&app, "/api/v1/overview", Some(&cookie)).await;
    let live = overview["rollouts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|rollout| rollout["id"] == "live")
        .unwrap();
    assert_eq!(
        live["state_counts"],
        json!({"verified_applied":2,"removed":1})
    );
    // Nothing was rewritten: every target keeps its stored state.
    let stored: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM deployment_targets WHERE state='verified_applied'",
    )
    .fetch_one(&s.pool)
    .await
    .unwrap();
    assert_eq!(stored, 12);
}

#[tokio::test]
async fn global_sort_precedes_pagination_and_keeps_identity_ties_and_nulls_last() {
    let (_temp, s, app, cookie) = fixture().await;
    insert(
        &s,
        "configuration",
        &json!({"id":"pipeline","name":"Bravo pipeline"}),
    )
    .await;
    insert(
        &s,
        "version",
        &json!({"id":"v","configuration_id":"pipeline","number":1}),
    )
    .await;
    for (id, name, state, scheduled, verified, total) in [
        (
            "a",
            Some("Zulu"),
            "active",
            Some("2026-04-01T00:00:00Z"),
            1,
            3,
        ),
        (
            "b",
            Some("alpha"),
            "completed",
            Some("2026-02-01T00:00:00Z"),
            2,
            4,
        ),
        ("c", Some("ALPHA"), "failed", None, 1, 2),
        ("d", None, "paused", None, 0, 1),
    ] {
        let mut d = deployment(id);
        d["name"] = json!(name);
        d["status"] = json!(state);
        d["scheduled_at"] = json!(scheduled);
        d["created_at"] = json!(format!(
            "2026-01-0{}T00:00:00Z",
            if id == "a" {
                4
            } else if id == "b" {
                3
            } else if id == "c" {
                2
            } else {
                1
            }
        ));
        insert(&s, "deployment", &d).await;
        for n in 0..total {
            let device = format!("{id}-{n}");
            sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,'{}')")
                .bind(&device)
                .bind(format!("Device {id} {}", total - n))
                .execute(&s.pool)
                .await
                .unwrap();
            sqlx::query("INSERT INTO deployment_targets(deployment_id,device_id,state,generation) VALUES(?,?,?,?)").bind(id).bind(&device).bind(if n<verified {"verified_applied"} else {"pending"}).bind(n as i64).execute(&s.pool).await.unwrap();
        }
    }
    for (sort, direction, expected) in [
        ("name", "asc", vec!["b", "c", "d", "a"]),
        ("name", "desc", vec!["a", "d", "b", "c"]),
        ("status", "asc", vec!["b", "c", "a", "d"]),
        ("status", "desc", vec!["d", "a", "c", "b"]),
        ("verified", "asc", vec!["d", "c", "a", "b"]),
        ("verified", "desc", vec!["b", "a", "c", "d"]),
        ("created_at", "asc", vec!["d", "c", "b", "a"]),
        ("created_at", "desc", vec!["a", "b", "c", "d"]),
        ("scheduled_at", "asc", vec!["b", "a", "c", "d"]),
        ("scheduled_at", "desc", vec!["a", "b", "c", "d"]),
    ] {
        let mut actual = Vec::new();
        for page in 1..=4 {
            let (status, body)=get(&app,&format!("/api/v1/deployments/history?sort={sort}&direction={direction}&page={page}&page_size=1"),Some(&cookie)).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["total"], 4);
            actual.push(body["items"][0]["id"].as_str().unwrap().to_owned());
        }
        assert_eq!(actual, expected, "{sort} {direction}");
    }
    // Sort is applied to the filtered set, before limiting, not to a visible page.
    let (_, filtered) = get(
        &app,
        "/api/v1/deployments/history?sort=name&direction=desc&search=alpha&page=2&page_size=1",
        Some(&cookie),
    )
    .await;
    assert_eq!(filtered["total"], 2);
    assert_eq!(filtered["items"][0]["id"], "c");
    for (sort, direction, expected) in [
        ("device_name", "asc", vec!["b-3", "b-2", "b-1", "b-0"]),
        ("device_name", "desc", vec!["b-0", "b-1", "b-2", "b-3"]),
        ("state", "asc", vec!["b-0", "b-1", "b-2", "b-3"]),
        ("state", "desc", vec!["b-2", "b-3", "b-0", "b-1"]),
        ("generation", "asc", vec!["b-0", "b-1", "b-2", "b-3"]),
        ("generation", "desc", vec!["b-3", "b-2", "b-1", "b-0"]),
    ] {
        let mut actual = Vec::new();
        for page in 1..=4 {
            let (status,body)=get(&app,&format!("/api/v1/deployments/b/targets?sort={sort}&direction={direction}&page={page}&page_size=1"),Some(&cookie)).await;
            assert_eq!(status, StatusCode::OK, "{body}");
            assert_eq!(body["total"], 4);
            actual.push(body["items"][0]["device_id"].as_str().unwrap().to_owned());
        }
        assert_eq!(actual, expected, "target {sort} {direction}");
    }
}

#[tokio::test]
async fn target_progress_sort_uses_terminal_pending_label_before_pagination() {
    let (_temp, s, app, cookie) = fixture().await;
    let states = [
        ("a", "pending"),
        ("b", "pending"),
        ("c", "rolled_back"),
        ("d", "verified_applied"),
        ("e", "removed"),
    ];
    for (device, _) in states {
        sqlx::query("INSERT INTO devices(id,name,data) VALUES(?,?,'{}')")
            .bind(device)
            .bind(format!("Device {device}"))
            .execute(&s.pool)
            .await
            .unwrap();
    }
    for status in [
        "failed",
        "cancelled",
        "missed",
        "unassigned",
        "active",
        "paused",
        "scheduled",
        "completed",
    ] {
        let mut d = deployment(status);
        d["status"] = json!(status);
        insert(&s, "deployment", &d).await;
        for (device, state) in states {
            sqlx::query(
                "INSERT INTO deployment_targets(deployment_id,device_id,state) VALUES(?,?,?)",
            )
            .bind(status)
            .bind(device)
            .bind(state)
            .execute(&s.pool)
            .await
            .unwrap();
        }
        let terminal = ["failed", "cancelled", "missed", "unassigned"].contains(&status);
        // No device follows a removed assignment: every row reads as removed,
        // so only the device ID orders them.
        let unassigned = status == "unassigned";
        for (direction, expected) in [
            (
                "asc",
                if unassigned {
                    vec!["a", "b", "c", "d", "e"]
                } else if terminal {
                    vec!["d", "e", "a", "b", "c"]
                } else {
                    vec!["d", "e", "c", "a", "b"]
                },
            ),
            (
                "desc",
                if unassigned {
                    vec!["a", "b", "c", "d", "e"]
                } else if terminal {
                    vec!["c", "a", "b", "e", "d"]
                } else {
                    vec!["a", "b", "c", "e", "d"]
                },
            ),
        ] {
            let mut actual = Vec::new();
            for page in 1..=states.len() {
                let (code, body) = get(&app, &format!("/api/v1/deployments/{status}/targets?sort=state&direction={direction}&page={page}&page_size=1"), Some(&cookie)).await;
                assert_eq!(code, StatusCode::OK, "{body}");
                assert_eq!(body["total"], states.len());
                actual.push(body["items"][0]["device_id"].as_str().unwrap().to_owned());
            }
            assert_eq!(actual, expected, "{status} {direction}");
        }
        let (_, pending) = get(
            &app,
            &format!(
                "/api/v1/deployments/{status}/targets?state=pending&sort=state&page_size=1&page=2"
            ),
            Some(&cookie),
        )
        .await;
        if unassigned {
            assert_eq!(pending["total"], 0);
            continue;
        }
        assert_eq!(pending["total"], 2);
        assert_eq!(pending["items"][0]["device_id"], "b");
        assert_eq!(
            pending["items"][0]["state"], "pending",
            "display sorting must not rewrite protocol state"
        );
    }
}

#[tokio::test]
async fn sort_parameters_are_strict_and_never_sql_expressions() {
    let (_temp, s, app, cookie) = fixture().await;
    insert(&s, "deployment", &deployment("one")).await;
    for path in [
        "/api/v1/deployments/history",
        "/api/v1/deployments/one/targets",
    ] {
        for query in [
            "sort=unknown",
            "sort=created_at%3BDROP%20TABLE%20records",
            "direction=sideways",
            "direction=ASC",
            "sort=name&sort=status",
            "direction=asc&direction=desc",
            "sort=",
            "direction=",
        ] {
            let (status, body) = get(&app, &format!("{path}?{query}"), Some(&cookie)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{path}?{query}: {body}");
            assert_eq!(body["error"]["code"], "INVALID_INPUT");
            assert!(!body.to_string().contains("DROP TABLE"));
        }
    }
}
