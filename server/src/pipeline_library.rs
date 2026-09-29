//! Bounded library projection. Configuration bodies stay inside SQLite and are
//! inspected only for the selected page's component counts.
use crate::{
    State, auth, db,
    error::{ApiError, Result},
};
use axum::{
    Json,
    extract::{Query, State as AppState},
    http::HeaderMap,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{QueryBuilder, Sqlite};

#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryQuery {
    search: Option<String>,
    state: Option<String>,
    sort: Option<String>,
    direction: Option<String>,
    page: Option<u64>,
    page_size: Option<u64>,
}

const ARCHIVED: &str = "COALESCE(json_type(data,'$.archived')='true',0)";
const UPDATED_ORDER: &str =
    "json_extract(data,'$.updated_at') DESC,json_extract(data,'$.name') COLLATE NOCASE ASC,id ASC";
const NAME_ORDER: &str = "json_extract(data,'$.name') COLLATE NOCASE ASC,id ASC";
fn sort_order(sort: Option<&str>, direction: Option<&str>) -> Result<&'static str> {
    match (sort.unwrap_or("updated"), direction) {
        ("updated", None | Some("desc")) => Ok(UPDATED_ORDER),
        ("name", None) => Ok(NAME_ORDER),
        ("name", Some("asc")) => {
            Ok("json_extract(data,'$.name') COLLATE NOCASE ASC NULLS LAST,id ASC")
        }
        ("name", Some("desc")) => {
            Ok("json_extract(data,'$.name') COLLATE NOCASE DESC NULLS LAST,id ASC")
        }
        ("updated", Some("asc")) => Ok(
            "json_extract(data,'$.updated_at') ASC NULLS LAST,json_extract(data,'$.name') COLLATE NOCASE ASC,id ASC",
        ),
        _ => Err(ApiError::invalid(
            "sort must be updated or name; direction must be asc or desc",
        )),
    }
}

fn filter(query: &mut QueryBuilder<'_, Sqlite>, state: &str, search: &str) {
    query.push(" WHERE kind='configuration'");
    if state != "all" {
        query
            .push(" AND ")
            .push(ARCHIVED)
            .push(if state == "archived" { "=1" } else { "=0" });
    }
    if !search.is_empty() {
        // instr treats %, _, brackets and backslashes literally. Only bound
        // values enter this expression; SQLite lower() folds ASCII only.
        query
            .push(" AND (instr(lower(COALESCE(json_extract(data,'$.name'),'')),lower(")
            .push_bind(search.to_owned())
            .push("))>0 OR instr(lower(COALESCE(json_extract(data,'$.description'),'')),lower(")
            .push_bind(search.to_owned())
            .push("))>0)");
    }
}

fn page_query(
    state: &str,
    search: &str,
    order: &str,
    size: i64,
    offset: i64,
) -> QueryBuilder<'static, Sqlite> {
    // Materialize the bounded page before counting components or looking up a
    // published version. Large drafts and artifacts are never sent to Rust.
    // Unary + on c.id removes TEXT column affinity so SQLite can use the
    // JSON-expression configuration_id index for the correlated version lookup.
    let mut query = QueryBuilder::new("WITH page AS MATERIALIZED (SELECT id,data FROM records");
    filter(&mut query, state, search);
    query
        .push(" ORDER BY ")
        .push(order)
        .push(" LIMIT ")
        .push_bind(size)
        .push(" OFFSET ")
        .push_bind(offset);
    query.push(") SELECT json_object(\
        'id',id,'name',json_extract(data,'$.name'),\
        'description',COALESCE(json_extract(data,'$.description'),''),\
        'revision',json_extract(data,'$.revision'),\
        'created_at',json_extract(data,'$.created_at'),'updated_at',json_extract(data,'$.updated_at'),\
        'archived',json(CASE WHEN json_type(data,'$.archived')='true' THEN 'true' ELSE 'false' END),\
        'archived_at',json_extract(data,'$.archived_at'),\
        'component_counts',json_object(\
          'sources',CASE WHEN json_type(data,'$.config.sources')='object' THEN (SELECT count(*) FROM json_each(c.data,'$.config.sources')) ELSE 0 END,\
          'transforms',CASE WHEN json_type(data,'$.config.transforms')='object' THEN (SELECT count(*) FROM json_each(c.data,'$.config.transforms')) ELSE 0 END,\
          'sinks',CASE WHEN json_type(data,'$.config.sinks')='object' THEN (SELECT count(*) FROM json_each(c.data,'$.config.sinks')) ELSE 0 END),\
        'latest_version',json((SELECT json_object('id',v.id,'number',json_extract(v.data,'$.number'),'created_at',json_extract(v.data,'$.created_at')) \
          FROM records AS v WHERE v.kind='version' AND json_extract(v.data,'$.configuration_id')=+c.id \
          ORDER BY CAST(json_extract(v.data,'$.number') AS INTEGER) DESC,v.id ASC LIMIT 1))) \
        FROM page AS c ORDER BY ");
    query.push(order);
    query
}

fn count_query(state: &str, search: &str) -> QueryBuilder<'static, Sqlite> {
    let mut query = QueryBuilder::new("SELECT count(*) FROM records");
    filter(&mut query, state, search);
    query
}

pub async fn library(
    AppState(s): AppState<State>,
    headers: HeaderMap,
    Query(query): Query<LibraryQuery>,
) -> Result<Json<Value>> {
    auth::authorize(&s, &headers, &[], false).await?;
    let search = query.search.as_deref().unwrap_or("").trim();
    if search.chars().count() > 200 {
        return Err(ApiError::invalid("Search must be at most 200 characters"));
    }
    let state = query.state.as_deref().unwrap_or("active");
    if !matches!(state, "active" | "archived" | "all") {
        return Err(ApiError::invalid("state must be active, archived or all"));
    }
    let order = sort_order(query.sort.as_deref(), query.direction.as_deref())?;
    let page = query.page.unwrap_or(1);
    let size = query.page_size.unwrap_or(12);
    if !(1..=9_007_199_254_740_991).contains(&page) || !(1..=50).contains(&size) {
        return Err(ApiError::invalid(
            "page must be a positive safe integer and page_size must be 1..50",
        ));
    }
    let offset = page
        .checked_sub(1)
        .and_then(|n| n.checked_mul(size))
        .and_then(|n| i64::try_from(n).ok())
        .ok_or_else(|| ApiError::invalid("page is too large"))?;
    let mut tx = s.pool.begin().await?;
    let total: i64 = count_query(state, search)
        .build_query_scalar()
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<String> = page_query(state, search, order, size as i64, offset)
        .build_query_scalar()
        .fetch_all(&mut *tx)
        .await?;
    let items = rows
        .iter()
        .map(|row| db::parse(row))
        .collect::<Result<Vec<_>>>()?;
    Ok(Json(
        json!({"items":items,"total":total,"page":page,"page_size":size}),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::{Row, sqlite::SqlitePoolOptions};

    #[tokio::test]
    async fn library_queries_use_metadata_indexes_and_bound_the_projected_page() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for (state, order, index) in [
            (
                "active",
                UPDATED_ORDER,
                "configuration_library_state_updated",
            ),
            ("archived", NAME_ORDER, "configuration_library_state_name"),
            ("all", UPDATED_ORDER, "configuration_library_updated"),
            ("all", NAME_ORDER, "configuration_library_name"),
        ] {
            let query = page_query(state, "", order, 12, 0);
            let plan = sqlx::query(&format!("EXPLAIN QUERY PLAN {}", query.sql()))
                .bind(12)
                .bind(0)
                .fetch_all(&pool)
                .await
                .unwrap();
            let details = plan
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(details.contains(index), "{state}: {details}");
            assert!(details.contains("MATERIALIZE page"), "{details}");
            assert!(details.contains("version_pipeline_sequence"), "{details}");
            assert!(
                details
                    .lines()
                    .any(|line| line.contains("version_pipeline_sequence")
                        && line.contains("<expr>=?")),
                "{details}"
            );
            let query = count_query(state, "");
            let plan = sqlx::query(&format!("EXPLAIN QUERY PLAN {}", query.sql()))
                .fetch_all(&pool)
                .await
                .unwrap();
            let details = plan
                .iter()
                .map(|row| row.get::<String, _>("detail"))
                .collect::<Vec<_>>()
                .join("\n");
            assert!(details.contains("INDEX"), "{details}");
            assert!(!details.contains("SCAN records"), "{details}");
        }
    }
    #[tokio::test]
    async fn explicit_direction_sorts_the_full_library_before_paging() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::migrate!("./migrations").run(&pool).await.unwrap();
        for (id, name, updated) in [
            ("a", "Zulu", "2026-01-01"),
            ("b", "Alpha", "2026-01-03"),
            ("c", "alpha", "2026-01-02"),
        ] {
            let value = json!({"id":id,"name":name,"updated_at":updated,"revision":1,"config":{}});
            sqlx::query(
                "INSERT INTO records(kind,id,data,created_at) VALUES('configuration',?,?,?)",
            )
            .bind(id)
            .bind(value.to_string())
            .bind(updated)
            .execute(&pool)
            .await
            .unwrap();
        }
        for (sort, direction, expected) in [
            ("name", "asc", vec!["b", "c", "a"]),
            ("name", "desc", vec!["a", "b", "c"]),
            ("updated", "asc", vec!["a", "c", "b"]),
            ("updated", "desc", vec!["b", "c", "a"]),
        ] {
            let mut actual = Vec::new();
            for offset in 0..3 {
                let row: String = page_query(
                    "all",
                    "",
                    sort_order(Some(sort), Some(direction)).unwrap(),
                    1,
                    offset,
                )
                .build_query_scalar()
                .fetch_one(&pool)
                .await
                .unwrap();
                actual.push(db::parse(&row).unwrap()["id"].as_str().unwrap().to_owned());
            }
            assert_eq!(actual, expected, "{sort} {direction}");
        }
        assert_eq!(sort_order(None, None).unwrap(), UPDATED_ORDER);
        assert_eq!(sort_order(Some("name"), None).unwrap(), NAME_ORDER);
        assert!(sort_order(Some("name"), Some("sideways")).is_err());
        assert!(sort_order(Some("name;DROP TABLE records"), Some("asc")).is_err());
    }
}
