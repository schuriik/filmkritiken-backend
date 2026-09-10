package main

import (
	"context"

	"github.com/DerBlum/filmkritiken-backend/domain/filmkritiken"
	"github.com/DerBlum/filmkritiken-backend/domain/session"
	httpInbound "github.com/DerBlum/filmkritiken-backend/http/inbound"
	"github.com/DerBlum/filmkritiken-backend/infrastructure/db/memory"
	"github.com/DerBlum/filmkritiken-backend/infrastructure/db/mongo"
	"github.com/DerBlum/filmkritiken-backend/infrastructure/db/seed"
	"github.com/caarlos0/env/v11"
	log "github.com/sirupsen/logrus"
)

type LogConfig struct {
	LogLevel string `env:"LOG_LEVEL" envDefault:"INFO"`
}

// PersistenceConfig selects the storage backend. "mongo" is the default,
// "memory" runs without a database for local development (all data is lost on exit).
type PersistenceConfig struct {
	Persistence string `env:"PERSISTENCE" envDefault:"mongo"`
}

type repository interface {
	filmkritiken.FilmkritikenRepository
	filmkritiken.ImageRepository
	session.SessionRepository
}

func main() {
	log.SetLevel(getLogLevel())
	log.Info("starting filmkritiken-backend")

	serverConfig := httpInbound.ServerConfig{}
	if err := env.Parse(&serverConfig); err != nil {
		panic(err)
	}

	authConfig := httpInbound.AuthConfig{}
	if err := env.Parse(&authConfig); err != nil {
		panic(err)
	}

	repo, err := newRepository(context.Background())
	if err != nil {
		panic(err)
	}
	filmkritikenService := filmkritiken.NewFilmkritikenService(repo, repo)

	err = httpInbound.StartServer(&serverConfig, &authConfig, filmkritikenService, repo)
	if err != nil {
		panic(err)
	}
}

func newRepository(ctx context.Context) (repository, error) {
	persistenceConfig := PersistenceConfig{}
	if err := env.Parse(&persistenceConfig); err != nil {
		return nil, err
	}

	if persistenceConfig.Persistence == "memory" {
		log.Warn("using in-memory persistence - all data is lost when the process exits")
		memoryRepository := memory.NewMemoryRepository()
		if err := seed.SeedIfEmpty(ctx, memoryRepository); err != nil {
			return nil, err
		}
		return memoryRepository, nil
	}

	mongoConfig := mongo.Config{}
	if err := env.Parse(&mongoConfig); err != nil {
		return nil, err
	}

	return mongo.NewMongoDbRepository(ctx, &mongoConfig)
}

func getLogLevel() log.Level {
	logConfig := LogConfig{}
	if err := env.Parse(&logConfig); err != nil {
		log.Warnf("could not parse LogLevel: %s, using INFO", logConfig.LogLevel)
		return log.InfoLevel
	} else {
		log.Infof("using log level %v", logConfig.LogLevel)
	}

	switch logConfig.LogLevel {
	case "TRACE":
		return log.TraceLevel
	case "DEBUG":
		return log.DebugLevel
	case "INFO":
		return log.InfoLevel
	case "WARNING":
		return log.WarnLevel
	case "FATAL":
		return log.FatalLevel
	case "PANIC":
		return log.PanicLevel
	default:
		return log.InfoLevel
	}

}
