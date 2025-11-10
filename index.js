const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors());
app.use(express.json());

// Инициализация Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("❌ SUPABASE_URL и SUPABASE_ANON_KEY обязательны!");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// ===================================================================
// Эндпоинт: получить список помещений (без пагинации, без count)
// ===================================================================
app.get("/premises", async (req, res) => {
  const { city, street, house } = req.query;

  try {
    let query = supabase
      .from("premises")
      .select("*")
      .order("city")
      .order("street")
      .order("house", { ascending: true })
      .order("apartment", { ascending: true, nullsFirst: true });

    if (city) query = query.eq("city", city);
    if (street) query = query.ilike("street", `%${street.trim()}%`);
    if (house) query = query.eq("house", house.trim());

    query = query.limit(1000);

    const { data, error } = await query;

    if (error) {
      console.error("Supabase error in /premises:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("Unexpected error in /premises:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: получить список долговых кейсов (с долгами)
// ===================================================================
app.get("/debt-cases", async (req, res) => {
  const {
    page = 0,
    pageSize = 20,
    city,
    status,
    minDebt,
    maxDebt,
    hasResponsibleParty,
  } = req.query;

  const size = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
  const from = page * size;
  const to = from + size - 1;

  try {
    let query = supabase
      .from("debt_case")
      .select(
        `
        *,
        premises:premises_id (
          id,
          city,
          street,
          house,
          apartment,
          full_address
        ),
        responsible_party:responsible_party_id (
          id,
          type,
          fio,
          legal_name,
          phone,
          email,
          represents_minor,
          minor_fio,
          relation_to_minor
        )
      `,
        { count: "exact" }
      )
      .order("created_at", { ascending: false });

    // Фильтрация
    if (city) {
      query = query.eq("premises.city", city);
    }
    if (status) {
      query = query.eq("status", status);
    }
    if (hasResponsibleParty === "true") {
      query = query.not("responsible_party_id", "is", null);
    } else if (hasResponsibleParty === "false") {
      query = query.is("responsible_party_id", null);
    }

    // Пагинация
    query = query.range(from, to);

    const { data: cases, error, count } = await query;

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    // Для каждого кейса загружаем debt_obligations через debt_case_id
    const casesWithObligations = await Promise.all(
      cases.map(async (debtCase) => {
        const { data: obligations, error: obligationsError } = await supabase
          .from("debt_obligation")
          .select(
            `
            *,
            service_provider:service_provider_id (
              id,
              name,
              type
            )
          `
          )
          .eq("debt_case_id", debtCase.id);

        if (obligationsError) {
          console.error("Error loading obligations:", obligationsError);
          return { ...debtCase, debt_obligations: [] };
        }

        return { ...debtCase, debt_obligations: obligations || [] };
      })
    );

    // Добавляем rowIndex и вычисляем общую сумму долга
    const dataWithIndex = casesWithObligations.map((row, i) => {
      const totalDebt = row.debt_obligations.reduce((sum, obligation) => {
        return sum + (obligation.debt_sum || 0) + (obligation.penalty_sum || 0);
      }, 0);

      return {
        ...row,
        rowIndex: page * size + i + 1,
        total_debt: totalDebt,
      };
    });

    // Фильтрация по сумме долга если указана
    let filteredData = dataWithIndex;
    if (minDebt) {
      filteredData = filteredData.filter(
        (item) => item.total_debt >= parseFloat(minDebt)
      );
    }
    if (maxDebt) {
      filteredData = filteredData.filter(
        (item) => item.total_debt <= parseFloat(maxDebt)
      );
    }

    res.json({
      data: filteredData,
      total: count,
      page: parseInt(page, 10),
      pageSize: size,
    });
  } catch (err) {
    console.error("Unexpected error in /debt-cases:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: получить карточку кейса по ID
// ===================================================================
app.get("/debt-cases/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Основные данные кейса + premises + responsible_party
    const { data: caseData, error: caseError } = await supabase
      .from("debt_case")
      .select(
        `
        *,
        premises:premises_id (*),
        responsible_party:responsible_party_id (*)
      `
      )
      .eq("id", id)
      .single();

    if (caseError) {
      console.error("Error loading case:", caseError);
      return res.status(404).json({ error: "Debt case not found" });
    }

    // Загружаем обязательства через debt_case_id
    const { data: obligations, error: obligationsError } = await supabase
      .from("debt_obligation")
      .select(
        `
        *,
        service_provider:service_provider_id (*)
      `
      )
      .eq("debt_case_id", id);

    if (obligationsError) {
      console.error("Error loading obligations:", obligationsError);
      return res.status(500).json({ error: "Error loading obligations" });
    }

    // История событий
    const { data: events, error: eventsError } = await supabase
      .from("case_event")
      .select("*")
      .eq("debt_case_id", id)
      .order("created_at", { ascending: false });

    // Документы
    const { data: documents, error: documentsError } = await supabase
      .from("document")
      .select("*")
      .eq("debt_case_id", id)
      .order("created_at", { ascending: false });

    res.json({
      ...caseData,
      debt_obligations: obligations || [],
      events: events || [],
      documents: documents || [],
    });
  } catch (err) {
    console.error("Error in /debt-cases/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: создать новое дело с долгами
// ===================================================================
app.post("/debt-cases", async (req, res) => {
  const {
    premises_id,
    debt_obligation_ids,
    responsible_party_id,
    status = "new",
  } = req.body;

  if (!premises_id) {
    return res.status(400).json({ error: "premises_id is required" });
  }

  if (!debt_obligation_ids || debt_obligation_ids.length === 0) {
    return res
      .status(400)
      .json({ error: "At least one debt obligation is required" });
  }

  try {
    // Создаем дело
    const { data: newCase, error: caseError } = await supabase
      .from("debt_case")
      .insert({
        premises_id,
        responsible_party_id,
        status,
      })
      .select("id")
      .single();

    if (caseError) {
      console.error("Error creating case:", caseError);
      return res.status(500).json({ error: caseError.message });
    }

    // Привязываем долги к делу
    const { error: updateError } = await supabase
      .from("debt_obligation")
      .update({ debt_case_id: newCase.id })
      .in("id", debt_obligation_ids);

    if (updateError) {
      console.error("Error updating obligations:", updateError);
      return res.status(500).json({ error: updateError.message });
    }

    // Создаем начальное событие
    await supabase.from("case_event").insert({
      debt_case_id: newCase.id,
      type: "case_created",
      description: "Дело создано",
      created_by: "system",
    });

    res.json({
      success: true,
      case_id: newCase.id,
      message: `Дело создано с ${debt_obligation_ids.length} долгами`,
    });
  } catch (err) {
    console.error("Error in /debt-cases POST:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: поиск долгов для создания нового дела
// ===================================================================
app.get("/debt-obligations", async (req, res) => {
  const {
    premises_id,
    city,
    street,
    house,
    minAmount,
    maxAmount,
    minPeriod,
    maxPeriod,
    service_provider_id,
    includeAssigned = false, // включать ли уже привязанные к делам долги
  } = req.query;

  try {
    let query = supabase
      .from("debt_obligation")
      .select(
        `
        *,
        premises:premises_id (*),
        service_provider:service_provider_id (*),
        debt_case:debt_case_id (id, status)
        `
      )
      .order("period_end", { ascending: false });

    // Фильтры
    if (premises_id) {
      query = query.eq("premises_id", premises_id);
    }
    if (city) {
      query = query.eq("premises.city", city);
    }
    if (street) {
      query = query.ilike("premises.street", `%${street}%`);
    }
    if (house) {
      query = query.eq("premises.house", house);
    }
    if (minAmount) {
      query = query.gte("debt_sum", parseFloat(minAmount));
    }
    if (maxAmount) {
      query = query.lte("debt_sum", parseFloat(maxAmount));
    }
    if (minPeriod) {
      query = query.lte("period_start", minPeriod);
    }
    if (maxPeriod) {
      query = query.gte("period_end", maxPeriod);
    }
    if (service_provider_id) {
      query = query.eq("service_provider_id", service_provider_id);
    }
    if (includeAssigned !== "true") {
      query = query.is("debt_case_id", null);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Supabase error in /debt-obligations:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data || []);
  } catch (err) {
    console.error("Unexpected error in /debt-obligations:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: получить список городов
// ===================================================================
app.get("/cities", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("premises")
      .select("city")
      .order("city");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    const cities = [...new Set(data.map((item) => item.city))].sort();
    res.json(cities);
  } catch (err) {
    console.error("Error in /cities:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: привязать ответственное лицо к кейсу
// ===================================================================
app.patch("/debt-cases/:id/responsible-party", async (req, res) => {
  const { id } = req.params;
  const {
    type,
    fio,
    legal_name,
    phone,
    email,
    represents_minor = false,
    minor_fio,
    relation_to_minor,
  } = req.body;

  if (!type) {
    return res.status(400).json({ error: "type is required" });
  }

  try {
    // Проверяем существование кейса
    const { data: caseExists, error: caseError } = await supabase
      .from("debt_case")
      .select("id")
      .eq("id", id)
      .single();

    if (caseError) {
      return res.status(404).json({ error: "Debt case not found" });
    }

    // Создаём ответственное лицо
    const { data: newParty, error: insertError } = await supabase
      .from("responsible_party")
      .insert({
        type,
        fio,
        legal_name,
        phone,
        email,
        represents_minor,
        minor_fio,
        relation_to_minor,
      })
      .select("id")
      .single();

    if (insertError) {
      return res.status(500).json({ error: insertError.message });
    }

    // Привязываем к кейсу
    const { error: updateError } = await supabase
      .from("debt_case")
      .update({ responsible_party_id: newParty.id })
      .eq("id", id);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    // Добавляем событие
    await supabase.from("case_event").insert({
      debt_case_id: id,
      type: "responsible_party_assigned",
      description: `Назначено ответственное лицо: ${fio || legal_name}`,
      created_by: "admin",
    });

    res.json({ success: true, responsible_party_id: newParty.id });
  } catch (err) {
    console.error("Error in /responsible-party assignment:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: получить список поставщиков услуг
// ===================================================================
app.get("/service-providers", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("service_provider")
      .select("*")
      .order("name");

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("Error in /service-providers:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Эндпоинт: получить список пользователей (операторов)
// ===================================================================
app.get("/users", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, fio, email, role, is_active, created_at")
      .eq("is_active", true)
      .order("fio", { ascending: true });

    if (error) {
      console.error("Supabase error:", error);
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("Error in /users:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Получить пользователя по ID
app.get("/users/:id", async (req, res) => {
  const { id } = req.params;

  if (!id) {
    return res.status(400).json({ error: "User ID is required" });
  }

  try {
    const { data, error } = await supabase
      .from("users")
      .select("id, fio, email, role, is_active, created_at")
      .eq("id", id)
      .single();

    if (error) {
      if (error.code === "PGRST116") {
        return res.status(404).json({ error: "User not found" });
      }
      return res.status(500).json({ error: error.message });
    }

    res.json(data);
  } catch (err) {
    console.error("Error in /users/:id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ===================================================================
// Запуск сервера
// ===================================================================
const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Debt Management Server running on port ${PORT}`);
});
