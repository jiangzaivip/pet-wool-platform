use axum::{
    extract::{Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post, put},
    Json, Router,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use sqlx::{postgres::PgPoolOptions, FromRow, PgPool};
use std::{collections::HashMap, env, net::SocketAddr, sync::Arc};
use tower_http::{cors::{Any, CorsLayer}, trace::TraceLayer};
use uuid::Uuid;

#[derive(Clone)]
struct AppState {
    pool: PgPool,
    jwt_secret: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let database_url = env::var("DATABASE_URL")?;
    let server_addr = env::var("SERVER_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let jwt_secret = env::var("JWT_SECRET").unwrap_or_else(|_| "dev_secret_change_me".to_string());
    let cors_origin = env::var("CORS_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".to_string());

    let pool = PgPoolOptions::new()
        .max_connections(10)
        .connect(&database_url)
        .await?;

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::POST, Method::PUT, Method::DELETE, Method::OPTIONS])
        .allow_headers(Any)
        .allow_origin(cors_origin.parse::<axum::http::HeaderValue>()?);

    let state = Arc::new(AppState { pool, jwt_secret });

    let app = Router::new()
        .route("/health", get(|| async { Json(json!({ "ok": true })) }))
        .nest("/api", api_routes())
        .with_state(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = server_addr.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("API listening on http://{}", addr);
    axum::serve(listener, app).await?;
    Ok(())
}

fn api_routes() -> Router<Arc<AppState>> {
    Router::new()
        .route("/site", get(get_site))
        .route("/products", get(list_products).post(admin_create_product))
        .route("/products/:id", put(admin_update_product).delete(admin_delete_product))
        .route("/faqs", get(list_faqs).post(admin_create_faq))
        .route("/faqs/:id", put(admin_update_faq).delete(admin_delete_faq))
        .route("/orders", post(create_order))
        .route("/admin/login", post(admin_login))
        .route("/admin/orders", get(admin_list_orders))
        .route("/admin/orders/:id/status", put(admin_update_order_status))
        .route("/admin/site", put(admin_update_site))
}

#[derive(Debug, Serialize)]
struct ApiError {
    message: String,
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, Json(self)).into_response()
    }
}

fn bad_request(message: impl Into<String>) -> ApiError {
    ApiError { message: message.into() }
}

#[derive(Debug, Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn require_admin(headers: &HeaderMap, secret: &str) -> Result<Claims, Response> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(|| (StatusCode::UNAUTHORIZED, Json(json!({"message":"missing token"}))).into_response())?;

    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|_| (StatusCode::UNAUTHORIZED, Json(json!({"message":"invalid token"}))).into_response())
}

#[derive(Deserialize)]
struct LangQuery {
    lang: Option<String>,
}

fn normalize_lang(lang: Option<String>) -> String {
    match lang.as_deref() {
        Some("en") => "en".to_string(),
        Some("ko") => "ko".to_string(),
        _ => "zh".to_string(),
    }
}

async fn get_site(State(state): State<Arc<AppState>>) -> Result<Json<HashMap<String, Value>>, ApiError> {
    let rows: Vec<(String, Value)> = sqlx::query_as("SELECT key, value FROM site_settings ORDER BY key")
        .fetch_all(&state.pool)
        .await
        .map_err(|e| bad_request(e.to_string()))?;
    Ok(Json(rows.into_iter().collect()))
}

#[derive(Debug, Serialize, FromRow)]
struct PublicProduct {
    id: Uuid,
    slug: String,
    base_price_cents: i32,
    currency: String,
    deposit_percent: i32,
    image_url: Option<String>,
    title: String,
    subtitle: String,
    description: String,
    specs: Value,
}

async fn list_products(
    State(state): State<Arc<AppState>>,
    Query(query): Query<LangQuery>,
) -> Result<Json<Vec<PublicProduct>>, ApiError> {
    let lang = normalize_lang(query.lang);
    let products = sqlx::query_as::<_, PublicProduct>(
        r#"
        SELECT p.id, p.slug, p.base_price_cents, p.currency, p.deposit_percent, p.image_url,
               t.title, t.subtitle, t.description, t.specs
        FROM products p
        JOIN product_translations t ON t.product_id = p.id AND t.lang = $1
        WHERE p.is_active = true
        ORDER BY p.sort_order ASC, p.created_at DESC
        "#,
    )
    .bind(lang)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| bad_request(e.to_string()))?;
    Ok(Json(products))
}

#[derive(Debug, Serialize, FromRow)]
struct PublicFaq {
    id: Uuid,
    question: String,
    answer: String,
}

async fn list_faqs(
    State(state): State<Arc<AppState>>,
    Query(query): Query<LangQuery>,
) -> Result<Json<Vec<PublicFaq>>, ApiError> {
    let lang = normalize_lang(query.lang);
    let faqs = sqlx::query_as::<_, PublicFaq>(
        r#"
        SELECT f.id, t.question, t.answer
        FROM faqs f
        JOIN faq_translations t ON t.faq_id = f.id AND t.lang = $1
        WHERE f.is_active = true
        ORDER BY f.sort_order ASC, f.created_at DESC
        "#,
    )
    .bind(lang)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| bad_request(e.to_string()))?;
    Ok(Json(faqs))
}

#[derive(Debug, Deserialize)]
struct CreateOrderRequest {
    product_id: Uuid,
    lang: Option<String>,
    customer_name: String,
    email: String,
    country: Option<String>,
    pet_name: Option<String>,
    pet_type: Option<String>,
    size_option: Option<String>,
    payment_type: String,
    notes: Option<String>,
    photo_urls: Option<Vec<String>>,
}

#[derive(Debug, Serialize, FromRow)]
struct ProductPriceRow {
    base_price_cents: i32,
    currency: String,
    deposit_percent: i32,
}

async fn create_order(
    State(state): State<Arc<AppState>>,
    Json(input): Json<CreateOrderRequest>,
) -> Result<Json<Value>, ApiError> {
    if input.customer_name.trim().is_empty() || input.email.trim().is_empty() {
        return Err(bad_request("name and email are required"));
    }

    let price = sqlx::query_as::<_, ProductPriceRow>(
        "SELECT base_price_cents, currency, deposit_percent FROM products WHERE id = $1 AND is_active = true",
    )
    .bind(input.product_id)
    .fetch_one(&state.pool)
    .await
    .map_err(|_| bad_request("product not found"))?;

    let amount = match input.payment_type.as_str() {
        "deposit" => price.base_price_cents * price.deposit_percent / 100,
        "balance" => price.base_price_cents * (100 - price.deposit_percent) / 100,
        "full" => price.base_price_cents,
        _ => return Err(bad_request("invalid payment_type")),
    };

    let short = Uuid::new_v4().simple().to_string()[0..8].to_uppercase();
    let order_no = format!("WP-{}-{}", Utc::now().format("%Y%m%d"), short);
    let photo_urls = serde_json::to_value(input.photo_urls.unwrap_or_default()).unwrap_or(json!([]));

    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO orders (
          order_no, product_id, lang, customer_name, email, country, pet_name, pet_type,
          size_option, payment_type, amount_cents, currency, notes, photo_urls
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING id
        "#,
    )
    .bind(&order_no)
    .bind(input.product_id)
    .bind(normalize_lang(input.lang))
    .bind(input.customer_name)
    .bind(input.email)
    .bind(input.country.unwrap_or_default())
    .bind(input.pet_name.unwrap_or_default())
    .bind(input.pet_type.unwrap_or_default())
    .bind(input.size_option.unwrap_or_default())
    .bind(input.payment_type)
    .bind(amount)
    .bind(price.currency)
    .bind(input.notes.unwrap_or_default())
    .bind(photo_urls)
    .fetch_one(&state.pool)
    .await
    .map_err(|e| bad_request(e.to_string()))?;

    Ok(Json(json!({ "id": id, "order_no": order_no, "amount_cents": amount })))
}

#[derive(Debug, Deserialize)]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Debug, FromRow)]
struct AdminRow {
    id: Uuid,
    email: String,
    password_hash: String,
}

async fn admin_login(
    State(state): State<Arc<AppState>>,
    Json(input): Json<LoginRequest>,
) -> Result<Json<Value>, Response> {
    let admin = sqlx::query_as::<_, AdminRow>("SELECT id, email, password_hash FROM admins WHERE email = $1")
        .bind(input.email.trim().to_lowercase())
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"message": e.to_string()}))).into_response())?;

    let Some(admin) = admin else {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({"message":"invalid email or password"}))).into_response());
    };

    if sha256_hex(&input.password) != admin.password_hash {
        return Err((StatusCode::UNAUTHORIZED, Json(json!({"message":"invalid email or password"}))).into_response());
    }

    let exp = (Utc::now() + Duration::hours(12)).timestamp() as usize;
    let token = encode(
        &Header::default(),
        &Claims { sub: admin.id.to_string(), exp },
        &EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    )
    .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"message": e.to_string()}))).into_response())?;

    Ok(Json(json!({ "token": token, "email": admin.email })))
}

#[derive(Debug, Serialize, FromRow)]
struct AdminOrder {
    id: Uuid,
    order_no: String,
    product_id: Option<Uuid>,
    customer_name: String,
    email: String,
    country: String,
    pet_name: String,
    pet_type: String,
    size_option: String,
    payment_type: String,
    amount_cents: i32,
    currency: String,
    notes: String,
    photo_urls: Value,
    status: String,
    created_at: chrono::DateTime<Utc>,
}

async fn admin_list_orders(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<Vec<AdminOrder>>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    let orders = sqlx::query_as::<_, AdminOrder>(
        r#"
        SELECT id, order_no, product_id, customer_name, email, country, pet_name, pet_type, size_option,
               payment_type, amount_cents, currency, notes, photo_urls, status, created_at
        FROM orders
        ORDER BY created_at DESC
        LIMIT 200
        "#,
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"message": e.to_string()}))).into_response())?;
    Ok(Json(orders))
}

#[derive(Debug, Deserialize)]
struct UpdateStatusRequest {
    status: String,
}

async fn admin_update_order_status(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<UpdateStatusRequest>,
) -> Result<Json<Value>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    sqlx::query("UPDATE orders SET status = $1, updated_at = now() WHERE id = $2")
        .bind(input.status)
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, Json(json!({"message": e.to_string()}))).into_response())?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize, Serialize, Clone)]
struct TranslationInput {
    lang: String,
    title: Option<String>,
    subtitle: Option<String>,
    description: Option<String>,
    specs: Option<Value>,
    question: Option<String>,
    answer: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProductInput {
    slug: String,
    base_price_cents: i32,
    currency: Option<String>,
    deposit_percent: Option<i32>,
    is_active: Option<bool>,
    sort_order: Option<i32>,
    image_url: Option<String>,
    translations: Vec<TranslationInput>,
}

async fn admin_create_product(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<ProductInput>,
) -> Result<Json<Value>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    let mut tx = state.pool.begin().await.map_err(internal_error)?;
    let id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO products (slug, base_price_cents, currency, deposit_percent, is_active, sort_order, image_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        RETURNING id
        "#,
    )
    .bind(input.slug)
    .bind(input.base_price_cents)
    .bind(input.currency.unwrap_or_else(|| "USD".into()))
    .bind(input.deposit_percent.unwrap_or(50))
    .bind(input.is_active.unwrap_or(true))
    .bind(input.sort_order.unwrap_or(0))
    .bind(input.image_url)
    .fetch_one(&mut *tx)
    .await
    .map_err(internal_error)?;

    upsert_product_translations(&mut tx, id, input.translations).await.map_err(internal_error)?;
    tx.commit().await.map_err(internal_error)?;
    Ok(Json(json!({ "id": id })))
}

async fn admin_update_product(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<ProductInput>,
) -> Result<Json<Value>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    let mut tx = state.pool.begin().await.map_err(internal_error)?;
    sqlx::query(
        r#"
        UPDATE products
        SET slug=$1, base_price_cents=$2, currency=$3, deposit_percent=$4, is_active=$5, sort_order=$6, image_url=$7, updated_at=now()
        WHERE id=$8
        "#,
    )
    .bind(input.slug)
    .bind(input.base_price_cents)
    .bind(input.currency.unwrap_or_else(|| "USD".into()))
    .bind(input.deposit_percent.unwrap_or(50))
    .bind(input.is_active.unwrap_or(true))
    .bind(input.sort_order.unwrap_or(0))
    .bind(input.image_url)
    .bind(id)
    .execute(&mut *tx)
    .await
    .map_err(internal_error)?;
    upsert_product_translations(&mut tx, id, input.translations).await.map_err(internal_error)?;
    tx.commit().await.map_err(internal_error)?;
    Ok(Json(json!({ "ok": true })))
}

async fn upsert_product_translations(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    product_id: Uuid,
    translations: Vec<TranslationInput>,
) -> anyhow::Result<()> {
    for t in translations {
        sqlx::query(
            r#"
            INSERT INTO product_translations (product_id, lang, title, subtitle, description, specs)
            VALUES ($1,$2,$3,$4,$5,$6)
            ON CONFLICT (product_id, lang)
            DO UPDATE SET title=EXCLUDED.title, subtitle=EXCLUDED.subtitle, description=EXCLUDED.description, specs=EXCLUDED.specs
            "#,
        )
        .bind(product_id)
        .bind(t.lang)
        .bind(t.title.unwrap_or_default())
        .bind(t.subtitle.unwrap_or_default())
        .bind(t.description.unwrap_or_default())
        .bind(t.specs.unwrap_or(json!([])))
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn admin_delete_product(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    sqlx::query("UPDATE products SET is_active = false, updated_at = now() WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct FaqInput {
    sort_order: Option<i32>,
    is_active: Option<bool>,
    translations: Vec<TranslationInput>,
}

async fn admin_create_faq(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<FaqInput>,
) -> Result<Json<Value>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    let mut tx = state.pool.begin().await.map_err(internal_error)?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO faqs (sort_order, is_active) VALUES ($1,$2) RETURNING id",
    )
    .bind(input.sort_order.unwrap_or(0))
    .bind(input.is_active.unwrap_or(true))
    .fetch_one(&mut *tx)
    .await
    .map_err(internal_error)?;
    upsert_faq_translations(&mut tx, id, input.translations).await.map_err(internal_error)?;
    tx.commit().await.map_err(internal_error)?;
    Ok(Json(json!({ "id": id })))
}

async fn admin_update_faq(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
    Json(input): Json<FaqInput>,
) -> Result<Json<Value>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    let mut tx = state.pool.begin().await.map_err(internal_error)?;
    sqlx::query("UPDATE faqs SET sort_order=$1, is_active=$2 WHERE id=$3")
        .bind(input.sort_order.unwrap_or(0))
        .bind(input.is_active.unwrap_or(true))
        .bind(id)
        .execute(&mut *tx)
        .await
        .map_err(internal_error)?;
    upsert_faq_translations(&mut tx, id, input.translations).await.map_err(internal_error)?;
    tx.commit().await.map_err(internal_error)?;
    Ok(Json(json!({ "ok": true })))
}

async fn upsert_faq_translations(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    faq_id: Uuid,
    translations: Vec<TranslationInput>,
) -> anyhow::Result<()> {
    for t in translations {
        sqlx::query(
            r#"
            INSERT INTO faq_translations (faq_id, lang, question, answer)
            VALUES ($1,$2,$3,$4)
            ON CONFLICT (faq_id, lang)
            DO UPDATE SET question=EXCLUDED.question, answer=EXCLUDED.answer
            "#,
        )
        .bind(faq_id)
        .bind(t.lang)
        .bind(t.question.unwrap_or_default())
        .bind(t.answer.unwrap_or_default())
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn admin_delete_faq(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Path(id): Path<Uuid>,
) -> Result<Json<Value>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    sqlx::query("UPDATE faqs SET is_active = false WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(internal_error)?;
    Ok(Json(json!({ "ok": true })))
}

#[derive(Debug, Deserialize)]
struct SiteUpdateRequest {
    key: String,
    value: Value,
}

async fn admin_update_site(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Json(input): Json<SiteUpdateRequest>,
) -> Result<Json<Value>, Response> {
    require_admin(&headers, &state.jwt_secret)?;
    sqlx::query(
        r#"
        INSERT INTO site_settings (key, value, updated_at)
        VALUES ($1, $2, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        "#,
    )
    .bind(input.key)
    .bind(input.value)
    .execute(&state.pool)
    .await
    .map_err(internal_error)?;
    Ok(Json(json!({ "ok": true })))
}

fn internal_error(e: impl std::fmt::Display) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "message": e.to_string() }))).into_response()
}
