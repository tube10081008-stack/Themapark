"""
BongPlay AI Backend — main.py
Layer 1 (LightGBM + Prophet) + Layer 2 (CQL) + Safety Filter
15분 단위 State 수신 → Safe Action 반환
"""
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field
from typing import List, Optional, Dict, Any
import numpy as np
import pandas as pd
import joblib
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

# ------------------------------------------------------------------
# 의존성 (환경에 미리 설치 필요)
#   pip install fastapi uvicorn pydantic numpy pandas lightgbm prophet d3rlpy joblib scikit-learn
# ------------------------------------------------------------------
import lightgbm as lgb
from prophet import Prophet
import d3rlpy

app = FastAPI(title="BongPlay AI Backend", version="2.0.0")

# ==================================================================
# 0. Pydantic 모델
# ==================================================================

class RawState(BaseModel):
    """봉플레이 프론트엔드에서 15분마다 보내는 원시 State"""
    timestamp: str                  # ISO 8601, e.g. "2027-07-15T14:30:00+09:00"
    day_of_week: int                # 0=월 ... 6=일 (단, 월요일 휴관이므로 0은 미수신)
    hour: int                       # 0 ~ 23
    month: int                      # 1 ~ 12
    is_weekend: bool
    is_festival: bool               # 은어축제 기간 여부
    temp_c: float
    wind_speed: float               # m/s
    wind_gust: Optional[float] = 0.0# 돌풍
    precipitation: float            # 1시간 강수량 mm
    humidity: int                   # %
    sky: str                        # "clear", "cloudy", "rain", " gusty"

    # 시설 실시간 상태
    zip_queue: int                  # 짚코스터 대기 인원
    net_queue: int                  # 넷트어드벤처 대기 인원
    cafe_queue: int                 # 카페 대기/주문 수
    zip_open: bool                  # 현재 개방 여부
    net_open: bool

    # 인력
    staff_zip: int                  # 짚코스터 안전요원
    staff_net: int                  # 넷트어드벤처 안전요원
    staff_cafe: int                 # 카페 운영 인력

    # 누적/잔여
    cumulative_visitors: int        # 금일 누적 방문객
    remaining_operating_minutes: int# 퇴장까지 남은 시간

    # 기타
    lighting_ok: bool = True        # 야간 조명 정상 여부
    last_ride_zip_timestamp: Optional[str] = None  # 마지막 탑승 시각

class ActionOutput(BaseModel):
    """AI가 제안하는 Action (Safety Filter 통과 후)"""
    open_zip: int                   # 0 or 1
    open_net: int                   # 0 or 1
    add_staff_zip: int              # 0, 1, 2
    add_staff_cafe: int             # 0 or 1
    issue_coupon: int               # 0 or 1
    price_adjustment: float         # -0.10 ~ +0.10
    coupon_discount_rate: float     # 0.00 ~ 0.20
    target_throughput_zip: float    # 0.80 ~ 1.20

    # 메타
    raw_action: Optional[Dict[str, Any]] = None   # Safety Filter 이전 원본
    safety_applied: bool = True
    predicted_zip_wait_next_15m: Optional[float] = None
    predicted_revenue_next_15m: Optional[float] = None

class EpisodeJson(BaseModel):
    """exportAiCausalDataset()에서 덤프되는 단일 에피소드"""
    episode_id: str
    date: str
    states: List[List[float]]       # (T, state_dim)
    actions: List[List[float]]    # (T, action_dim)
    rewards: List[float]           # (T,)
    terminals: List[float]         # (T,)  마지막 step만 1.0
    metadata: Optional[Dict] = None

class TrainRequest(BaseModel):
    episodes: List[EpisodeJson]
    retrain_layer1: bool = True
    retrain_layer2: bool = True
    n_steps_cql: int = 100_000

# ==================================================================
# 1. Safety Filter (Layer 3)
# ==================================================================

class SafetyFilter:
    """Hard Constraint — RL 위에 반드시 얹는다"""
    MIN_STAFF_ZIP = 2
    MAX_QUEUE_PER_STAFF = 6
    MAX_WIND_SPEED = 12.0           # m/s
    MAX_WIND_GUST = 15.0
    MIN_REST_BETWEEN_RIDES_SEC = 300
    PRICE_ADJ_LIMIT = (-0.10, 0.10)
    COUPON_DISCOUNT_LIMIT = (0.0, 0.20)
    THROUGHPUT_LIMIT = (0.80, 1.20)

    def filter(self, state: RawState, action: np.ndarray) -> np.ndarray:
        """
        action 순서 (8차원):
        [open_zip, open_net, add_staff_zip, add_staff_cafe,
         issue_coupon, price_adj, coupon_discount, target_throughput]
        """
        a = action.copy()

        # 1. 풍/돌풍 시 야외 시설 강제 폐쇄
        if state.wind_speed > self.MAX_WIND_SPEED or (state.wind_gust or 0) > self.MAX_WIND_GUST:
            a[0] = 0.0  # open_zip = 0

        # 2. 야간 조명 불량 시 야외 시설 폐쇄
        if state.hour >= 17 and not state.lighting_ok:
            a[0] = 0.0

        # 3. 안전요원 부족 시 강제 증원
        required_staff = max(self.MIN_STAFF_ZIP, int(np.ceil(state.zip_queue / self.MAX_QUEUE_PER_STAFF)))
        deficit = required_staff - state.staff_zip
        if deficit > 0:
            a[2] = max(a[2], deficit)  # add_staff_zip

        # 4. 연속 변수 클리핑
        a[5] = np.clip(a[5], *self.PRICE_ADJ_LIMIT)
        a[6] = np.clip(a[6], *self.COUPON_DISCOUNT_LIMIT)
        a[7] = np.clip(a[7], *self.THROUGHPUT_LIMIT)

        # 5. 이산 변수 반올림/클리핑
        a[0] = 1 if a[0] >= 0.5 else 0   # open_zip
        a[1] = 1 if a[1] >= 0.5 else 0   # open_net
        a[2] = int(np.clip(round(a[2]), 0, 2))   # add_staff_zip
        a[3] = 1 if a[3] >= 0.5 else 0   # add_staff_cafe
        a[4] = 1 if a[4] >= 0.5 else 0   # issue_coupon

        return a

safety_filter = SafetyFilter()

# ==================================================================
# 2. Layer 1: Prophet + LightGBM 예측기
# ==================================================================

class Layer1Enricher:
    """Raw State → AI State (예측 변수 덧붙임)"""

    PROPHET_PATH = "./models/prophet_visitor.pkl"
    LGB_ZIP_PATH = "./models/lgb_zip_wait.pkl"
    LGB_NET_PATH = "./models/lgb_net_wait.pkl"
    LGB_CAF_PATH = "./models/lgb_cafe_attach.pkl"
    LGB_REV_PATH = "./models/lgb_hourly_revenue.pkl"

    def __init__(self):
        self.prophet = None
        self.lgb_zip = None
        self.lgb_net = None
        self.lgb_cafe = None
        self.lgb_rev = None
        self._load_models()
        self._build_festival_df()

    def _build_festival_df(self):
        # 은어축제 9일 (예시: 7월 마지막 주 ~ 8월 첫째 주)
        festival_dates = pd.date_range("2027-07-31", periods=9, freq="D")
        self.festival_df = pd.DataFrame({
            "holiday": "eunoe_festival",
            "ds": festival_dates,
            "lower_window": 0,
            "upper_window": 0,
        })

    def _load_models(self):
        if os.path.exists(self.PROPHET_PATH):
            self.prophet = joblib.load(self.PROPHET_PATH)
        if os.path.exists(self.LGB_ZIP_PATH):
            self.lgb_zip = joblib.load(self.LGB_ZIP_PATH)
        if os.path.exists(self.LGB_NET_PATH):
            self.lgb_net = joblib.load(self.LGB_NET_PATH)
        if os.path.exists(self.LGB_CAF_PATH):
            self.lgb_cafe = joblib.load(self.LGB_CAF_PATH)
        if os.path.exists(self.LGB_REV_PATH):
            self.lgb_rev = joblib.load(self.LGB_REV_PATH)

    def _base_features(self, s: RawState) -> pd.DataFrame:
        """LightGBM 입력용 피처 행렬 (1행)"""
        return pd.DataFrame([{
            "hour": s.hour,
            "month": s.month,
            "day_of_week": s.day_of_week,
            "is_weekend": int(s.is_weekend),
            "is_festival": int(s.is_festival),
            "temp_c": s.temp_c,
            "wind_speed": s.wind_speed,
            "wind_gust": s.wind_gust or 0,
            "precipitation": s.precipitation,
            "humidity": s.humidity,
            "zip_queue": s.zip_queue,
            "net_queue": s.net_queue,
            "cafe_queue": s.cafe_queue,
            "zip_open": int(s.zip_open),
            "net_open": int(s.net_open),
            "staff_zip": s.staff_zip,
            "staff_net": s.staff_net,
            "staff_cafe": s.staff_cafe,
            "cumulative_visitors": s.cumulative_visitors,
            "remaining_minutes": s.remaining_operating_minutes,
            "lighting_ok": int(s.lighting_ok),
        }])

    def enrich(self, s: RawState) -> np.ndarray:
        """
        RawState → AI State Vector (예측 변수 4개 추가)
        최종 차원: raw 24 + predicted 4 = 28 (예시)
        """
        X = self._base_features(s)

        # --- Prophet: 향후 4시간 방문객 예측 (미학습 시 fallback) ---
        if self.prophet:
            future = pd.DataFrame({"ds": [pd.to_datetime(s.timestamp)]})
            prophet_pred = self.prophet.predict(future)["yhat"].values[0]
            prophet_unc = self.prophet.predict(future)["yhat_upper"].values[0] - prophet_pred
        else:
            prophet_pred = 0.0
            prophet_unc = 0.0

        # --- LightGBM: 단기 예측 ---
        zip_wait = self.lgb_zip.predict(X)[0] if self.lgb_zip else 0.0
        net_wait = self.lgb_net.predict(X)[0] if self.lgb_net else 0.0
        cafe_attach = self.lgb_cafe.predict(X)[0] if self.lgb_cafe else 0.45
        hourly_rev = self.lgb_rev.predict(X)[0] if self.lgb_rev else 0.0

        # --- 최종 State Vector 구성 ---
        # 순서는 학습 시와 반드시 동일해야 함
        state_vec = np.array([
            s.hour / 23.0,
            s.month / 12.0,
            s.day_of_week / 6.0,
            float(s.is_weekend),
            float(s.is_festival),
            s.temp_c / 40.0,
            s.wind_speed / 20.0,
            (s.wind_gust or 0) / 20.0,
            s.precipitation / 50.0,
            s.humidity / 100.0,
            s.zip_queue / 50.0,
            s.net_queue / 50.0,
            s.cafe_queue / 30.0,
            float(s.zip_open),
            float(s.net_open),
            s.staff_zip / 5.0,
            s.staff_net / 5.0,
            s.staff_cafe / 5.0,
            s.cumulative_visitors / 500.0,
            s.remaining_operating_minutes / 600.0,
            float(s.lighting_ok),
            # Layer 1 예측값
            prophet_pred / 100.0,
            prophet_unc / 100.0,
            zip_wait / 30.0,
            net_wait / 30.0,
            cafe_attach,
            hourly_rev / 100.0,
        ], dtype=np.float32)

        return state_vec, {
            "prophet_pred_visitors": prophet_pred,
            "prophet_unc": prophet_unc,
            "pred_zip_wait": zip_wait,
            "pred_net_wait": net_wait,
            "pred_cafe_attach": cafe_attach,
            "pred_hourly_revenue": hourly_rev,
        }

    def train_prophet(self, df_daily: pd.DataFrame):
        """df_daily: columns ['ds', 'y'] (일별 방문객)"""
        model = Prophet(
            yearly_seasonality=True,
            daily_seasonality=False,
            holidays=self.festival_df,
        )
        model.fit(df_daily)
        os.makedirs("./models", exist_ok=True)
        joblib.dump(model, self.PROPHET_PATH)
        self.prophet = model
        return model

    def train_lightgbms(self, df: pd.DataFrame):
        """
        df columns:
        ['hour','month','day_of_week','is_weekend','is_festival',
         'temp_c','wind_speed','wind_gust','precipitation','humidity',
         'zip_queue','net_queue','cafe_queue','zip_open','net_open',
         'staff_zip','staff_net','staff_cafe','cumulative_visitors',
         'remaining_minutes','lighting_ok',
         'zip_wait_next','net_wait_next','cafe_attach_next','hourly_revenue_next']
        """
        feature_cols = [
            "hour","month","day_of_week","is_weekend","is_festival",
            "temp_c","wind_speed","wind_gust","precipitation","humidity",
            "zip_queue","net_queue","cafe_queue","zip_open","net_open",
            "staff_zip","staff_net","staff_cafe","cumulative_visitors",
            "remaining_minutes","lighting_ok",
        ]

        targets = {
            self.LGB_ZIP_PATH: "zip_wait_next",
            self.LGB_NET_PATH: "net_wait_next",
            self.LGB_CAF_PATH: "cafe_attach_next",
            self.LGB_REV_PATH: "hourly_revenue_next",
        }

        for path, tgt in targets.items():
            params = {
                "objective": "regression",
                "metric": "rmse",
                "boosting_type": "gbdt",
                "num_leaves": 31,
                "learning_rate": 0.05,
                "feature_fraction": 0.9,
                "verbose": -1,
            }
            train_data = lgb.Dataset(df[feature_cols], label=df[tgt])
            model = lgb.train(params, train_data, num_boost_round=200)
            os.makedirs("./models", exist_ok=True)
            joblib.dump(model, path)

        self._load_models()

layer1 = Layer1Enricher()

# ==================================================================
# 3. Layer 2: CQL Policy
# ==================================================================

class CQLPolicy:
    MODEL_PATH = "./models/cql_policy.d3"

    def __init__(self, state_dim: int = 27, action_dim: int = 8):
        self.state_dim = state_dim
        self.action_dim = action_dim
        self.cql = None
        self._load()

    def _load(self):
        if os.path.exists(self.MODEL_PATH):
            # d3rlpy v2.x: load from path
            self.cql = d3rlpy.load_learnable(self.MODEL_PATH)

    def predict(self, state_vec: np.ndarray) -> np.ndarray:
        if self.cql is None:
            # 미학습 시: heuristic fallback (안전 중심)
            return self._fallback_action(state_vec)

        x = state_vec.reshape(1, -1)
        action = self.cql.predict(x)[0]  # (action_dim,)
        return action

    def _fallback_action(self, state_vec: np.ndarray) -> np.ndarray:
        """CQL 미학습 시 안전한 기본 정책"""
        # state_vec[10] = zip_queue/50, state_vec[6] = wind_speed/20
        zip_queue = state_vec[10] * 50
        wind = state_vec[6] * 20

        open_zip = 1.0 if wind < 12 else 0.0
        open_net = 1.0
        add_staff_zip = 1.0 if zip_queue > 12 else 0.0
        add_staff_cafe = 0.0
        issue_coupon = 0.0
        price_adj = 0.0
        coupon_discount = 0.0
        target_throughput = 1.0

        return np.array([
            open_zip, open_net, add_staff_zip, add_staff_cafe,
            issue_coupon, price_adj, coupon_discount, target_throughput
        ], dtype=np.float32)

    def train(self, dataset: d3rlpy.dataset.MDPDataset, n_steps: int = 100_000):
        """CQL 학습 — 처음 1회 또는 주기적 재학습"""
        # d3rlpy v2.x Config API
        config = d3rlpy.algos.CQLConfig(
            actor_learning_rate=3e-4,
            critic_learning_rate=3e-4,
            temp_learning_rate=3e-4,
            alpha_learning_rate=3e-4,
            n_critics=2,
        )
        self.cql = config.create(device="cpu")

        self.cql.fit(
            dataset,
            n_steps=n_steps,
            n_steps_per_epoch=5000,
            save_interval=10,
        )
        os.makedirs("./models", exist_ok=True)
        self.cql.save(self.MODEL_PATH)

    def build_mdp_dataset_from_json(self, episodes: List[EpisodeJson]) -> d3rlpy.dataset.MDPDataset:
        """exportAiCausalDataset() JSON → d3rlpy MDPDataset"""
        obs_list, act_list, rew_list, term_list = [], [], [], []

        for ep in episodes:
            obs = np.array(ep.states, dtype=np.float32)
            act = np.array(ep.actions, dtype=np.float32)
            rew = np.array(ep.rewards, dtype=np.float32)
            term = np.array(ep.terminals, dtype=np.float32)

            obs_list.append(obs)
            act_list.append(act)
            rew_list.append(rew)
            term_list.append(term)

        observations = np.vstack(obs_list)
        actions = np.vstack(act_list)
        rewards = np.concatenate(rew_list)
        terminals = np.concatenate(term_list)

        return d3rlpy.dataset.MDPDataset(
            observations=observations,
            actions=actions,
            rewards=rewards,
            terminals=terminals,
        )

cql_policy = CQLPolicy(state_dim=27, action_dim=8)

# ==================================================================
# 4. FastAPI 엔드포인트
# ==================================================================

@app.get("/health")
def health():
    return {
        "status": "ok",
        "prophet_loaded": layer1.prophet is not None,
        "lgb_loaded": {
            "zip": layer1.lgb_zip is not None,
            "net": layer1.lgb_net is not None,
            "cafe": layer1.lgb_cafe is not None,
            "rev": layer1.lgb_rev is not None,
        },
        "cql_loaded": cql_policy.cql is not None,
    }

@app.post("/predict", response_model=ActionOutput)
def predict(state: RawState):
    """
    15분마다 봉플레이 프론트엔드가 호출
    RawState → Layer1 enrich → CQL predict → Safety Filter → ActionOutput
    """
    # 1. Layer 1: 예측 변수 추가
    state_vec, preds = layer1.enrich(state)

    # 2. Layer 2: CQL 정책 추론
    raw_action = cql_policy.predict(state_vec)

    # 3. Layer 3: Safety Filter
    safe_action = safety_filter.filter(state, raw_action)

    return ActionOutput(
        open_zip=int(safe_action[0]),
        open_net=int(safe_action[1]),
        add_staff_zip=int(safe_action[2]),
        add_staff_cafe=int(safe_action[3]),
        issue_coupon=int(safe_action[4]),
        price_adjustment=float(safe_action[5]),
        coupon_discount_rate=float(safe_action[6]),
        target_throughput_zip=float(safe_action[7]),
        raw_action={
            "open_zip": float(raw_action[0]),
            "open_net": float(raw_action[1]),
            "add_staff_zip": float(raw_action[2]),
            "add_staff_cafe": float(raw_action[3]),
            "issue_coupon": float(raw_action[4]),
            "price_adjustment": float(raw_action[5]),
            "coupon_discount_rate": float(raw_action[6]),
            "target_throughput_zip": float(raw_action[7]),
        },
        safety_applied=True,
        predicted_zip_wait_next_15m=round(float(preds["pred_zip_wait"]), 1),
        predicted_revenue_next_15m=round(float(preds["pred_hourly_revenue"]), 0),
    )

@app.post("/train")
def train(req: TrainRequest):
    """
    봉플레이에서 exportAiCausalDataset() JSON을 받아 전체 재학습
    운영 환경에서는 백그라운드 Celery/ARQ로 비동기 처리 권장
    """
    results = {}

    # --- Layer 2: CQL 재학습 ---
    if req.retrain_layer2:
        mdp_dataset = cql_policy.build_mdp_dataset_from_json(req.episodes)
        cql_policy.train(mdp_dataset, n_steps=req.n_steps_cql)
        results["cql"] = f"trained on {len(req.episodes)} episodes, {req.n_steps_cql} steps"

    # --- Layer 1: Prophet + LightGBM 재습 ---
    if req.retrain_layer1:
        # 에피소드에서 일별/시간별 집계 데이터 재구성 (간략화)
        # 실제로는 봉플레이 측에서 별도 학습용 CSV를 제공하는 것이 더 깔끔
        results["layer1"] = "use /train_layer1 with structured CSV for production"

    return {"status": "training_complete", "details": results}

@app.post("/train_layer1")
def train_layer1(csv_path: str):
    """
    봉플레이에서 제공하는 학습용 CSV 경로
    columns: ds, y (일별 방문객) + 피처들
    """
    df = pd.read_csv(csv_path)
    if "ds" in df.columns and "y" in df.columns:
        layer1.train_prophet(df[["ds", "y"]])
    # LightGBM 학습은 별도 피처 CSV 필요
    return {"status": "layer1_trained"}

# ------------------------------------------------------------------
# 실행: uvicorn main:app --host 0.0.0.0 --port 8000
# ------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
