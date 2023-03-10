var util = require('util');
var proxy = require('./jsutil.js').proxy;

var Player = require('./Player.js').Player,
    Card = require('./Card.js').Card,
    Deck = require('./Deck.js').Deck,
    SetCalculator = require('./SetCalculator.js'),
    _ = require('underscore');

var log = util.puts;

var Game = this.Game = function(eventEngine, id) {

    var deck = new Deck();
    this.id = id;
    this.cardsInPlay = [];
    this.players = [];
    this.eventEngine = eventEngine;
    this.startTime = new Date();
    this._cleanupPlayersIntervalId = null;

    //var playerTimeout = 15*60*1000; // 15 minutes
    var playerTimeout = 20*1000, // shorter timeout (useful for testing/debugging)
        moreCardsRequestThreshold = 2/3, // minimum percentage of card requests required to deal more cards
        endGameRequestThreshold = 2/3; // minimum percentage of end game requests required to end game
        

    this.restartGameRequestThreshold = 2/3; // minimum percentage of restart game requests required to restart game
    this.goalScore = 10;

    function init() {

        this.eventEngine.observe('client:game:' + this.id + ':registerPlayer', _.bind(this.onRegisterPlayer, this));
        this.eventEngine.observe('client:game:' + this.id + ':selectCards', _.bind(this.onSelectCards, this));
        this.eventEngine.observe('client:game:' + this.id + ':startGame', _.bind(this.onStartGame, this));
        this.eventEngine.observe('client:game:' + this.id + ':cancelRestartGameRequest', _.bind(this.onCancelRestartGameRequest, this));
        this.eventEngine.observe('client:game:' + this.id + ':leave', _.bind(this.onLeave, this));
        this.eventEngine.observe('client:game:' + this.id + ':stay', _.bind(this.onStay, this));
        this.eventEngine.observe('client:game:' + this.id + ':changeName', _.bind(this.onChangeName, this));

        this.startGame();
        this._cleanupPlayersIntervalId = setInterval(proxy(this._cleanupPlayers, this), Math.floor(playerTimeout / 2)); // TODO: cleanup players
    }

    this.getPlayer = function(playerId) {
        for (var i = 0, n = this.players.length; i < n; i += 1) {
            var player = this.players[i];
            if (player.getId() == playerId) {
                return player;
            }
        }
        return null;
    };
    
    this.numMoreCardsRequests = function() {
        return this.players.reduce(function(count, player) {
            return count + (player.isRequestingMoreCards ? 1 : 0);
        }, 0);
    };
    this.numEndGameRequests = function() {
        return this.players.reduce(function(count, player) {
            return count + (player.isRequestingGameEnd ? 1 : 0);
        }, 0);
    };
    this.numRestartGameRequests = function() {
        return this.players.reduce(function(count, player) {
            return count + (player.isRequestingGameRestart ? 1 : 0);
        }, 0);
    };
    this._sortPlayersByScore = function() {
        this.players.sort(function(a, b) {
            if (a.score > b.score) {
                return -1;
            } else if (a.score < b.score) {
                return 1;
            } else {
                return 0;
            }
        });
    };
    
    this._isValidSet = function(cards) {
        var isInPlay = _.bind(this._isCardInPlay, this);
        return SetCalculator.isValidSet(cards) && _.every(cards, isInPlay);
    };

    this._isCardInPlay = function(card) {
        for (var i = 0, n = this.cardsInPlay.length; i < n; i += 1) {
            if (Card.equals(this.cardsInPlay[i], card)) {
                return true;
            }
        }
        return false;
    };

    this._cleanupPlayers = function() {
        console.log('cleaning up players');
        var now = (new Date()).getTime();
        var numPlayers = this.players.length;
        for (var i = 0; i < this.players.length; i += 1) {
            var player = this.players[i];
            if (player.lastSeen < now - playerTimeout) {
                console.log('removed player ' + i);
                this.players.splice(i, 1);
                i -= 1;
            }
        }
        if (numPlayers !== this.players.length) { // if a player left players, then notify other players
            this.eventEngine.fire('server:game:' + this.id + ':gameUpdated', this.gameState());
        }
    };
    
    this.gameState = function() {
        return {
            id: this.id,
            cardsInPlay : this.cardsInPlay,
            players : this.players,
            deckSize : deck.numCards(),
            numMoreCardsRequests : this.numMoreCardsRequests(),
            numRestartGameRequests : this.numRestartGameRequests(),
            numEndGameRequests : this.numEndGameRequests()
        };
    };

    this.registerPlayer = function(registerId, secret, name) {
        console.log('Game:registerPlayer: registerId=' + registerId + ', secret=' + secret);
        var player = new Player();
        player.lastSeen = (new Date()).getTime();
        player.joinGame(this);
        player.name = name || player.name;

        var encPlayerId = secret + player.getId();
        this.eventEngine.fire('server:game:' + this.id + ':playerRegistered', {
            registerId: registerId,
            encPlayerId: encPlayerId,
            playerPublicId: player.publicId,
            playerTimeout: playerTimeout,
            name: player.name
        });
        this.eventEngine.fire('server:game:' + this.id + ':gameUpdated', this.gameState());
    };

    this.addPlayer = function(player) {
        for (var i = 0, n = this.players.length; i < n; i += 1) {
            if (Player.equals(this.players[i], player)) {
                return false;
            }
        }
        this.players.push(player);
        return true;
    };

    this.removePlayer = function(playerId) {
        for (var i = 0, n = this.players.length; i < n; i += 1) {
            if (this.players[i].getId() == playerId) {
                console.log('removing player ' + playerId);
                this.players.splice(i, 1);
                return true;
            }
        }
        return false;
    };

    this.processSet = function(cards) {
        if (!this._isValidSet(cards)) {
            return false;
        }

        for (var i = 0, n = cards.length; i < n; i += 1) {
            var card = cards[i];
            for (var j = 0, m = this.cardsInPlay.length; j < m; j += 1) {
                if (Card.equals(this.cardsInPlay[j], card)) {
                    if (this.cardsInPlay.length <= 12 && !deck.isEmpty()) { // replace the card if there are fewer than 12 cards and deck is not empty
                        this.cardsInPlay[j] = null;
                    }// else { // if there are more than 12 cards in play or no cards left just remove the card
                    //     this.cardsInPlay.splice(j, 1);
                    // }
                    deck.addCard(card); // put the card back into the deck
                    break;
                }
            }
        }

        this.addCard(deck.drawCard());
        this.addCard(deck.drawCard());
        if (this.hasSet()) {
            this.addCard(deck.drawCard());
        } else {
            var randomTwoCards = this.getNRandomCardsInPlay(2);
            var cardNeededForSet = SetCalculator.getCardNeededToCompleteSet(randomTwoCards);
            this.addCard(deck.drawSpecificCard(cardNeededForSet));
        }

        return true;
    };

    this.startGame = function() {
        deck = new Deck();
        this.cardsInPlay = [];
        
        var i;

        // deal 11 cards first, and if there isn't a set within the first 11 cards,
        // make sure the last card completes a set
        for (i = 0; i < 11; i += 1) {
            this.cardsInPlay.push(deck.drawCard());
        }
        if (this.hasSet()) {
            this.addCard(deck.drawCard());
        } else {
            var randomTwoCards = this.getNRandomCardsInPlay(2);
            var cardNeededForSet = SetCalculator.getCardNeededToCompleteSet(randomTwoCards);
            this.addCard(deck.drawSpecificCard(cardNeededForSet));
        }

        for (i = 0, n = this.players.length; i < n; i += 1) {
            var player = this.players[i];
            player.score = 0;
            player.numSets = 0;
            player.numFalseSets = 0;
            player.isRequestingMoreCards = false;
            player.isRequestingGameEnd = false;
            player.isRequestingGameRestart = false;
        }
        this.eventEngine.fire('server:game:' + this.id + ':gameStarted', this.gameState());
    };

    this.addCard = function(card) {
        for (var i = 0, n = this.cardsInPlay.length; i < n; i += 1) {
            if (!this.cardsInPlay[i]) {
                this.cardsInPlay[i] = card;
                return this;
            }
        }
        this.cardsInPlay.push(deck.drawCard());
        return this;
    };

    this.dealMoreCards = function() {
        var i, player, n;
        for (i = 0; i < 3; i += 1) {
            if (!deck.isEmpty()) {
                this.addCard(deck.drawCard());
            }
        }
        for (i = 0, n = this.players.length; i < n; i++) {
            player = this.players[i];
            player.isRequestingMoreCards = false;
        }
        this.eventEngine.fire('server:game:' + this.id + ':gameUpdated', this.gameState());
    };

    this.hasSet = function() {
        var n = this.cardsInPlay.length;
        for (var i = 0; i < n; i += 1) {
            var cardI = this.cardsInPlay[i];
            for (var j = i+1; j < n; j += 1) {
                var cardJ = this.cardsInPlay[j];
                for (var k = j+1; k < n; k += 1) {
                    var cardK = this.cardsInPlay[k];
                    if (this._isValidSet([cardI, cardJ, cardK])) {
                        return true;
                    }
                }
            }
        }
        return false;
    };

    this.getNRandomCardsInPlay = function(n) {
        if (typeof n !== 'number') {
            throw 'n must be a number';
        }
        n = Math.floor(n);
        var cards = _.compact(this.cardsInPlay);

        var randomCards = [];
        while (randomCards.length < n) {
            var i = Math.floor(Math.random() * cards.length);
            randomCards.push(cards.splice(i, 1)[0]);
        }
        return randomCards;
    };
    
    this.endGame = function() {
        this._sortPlayersByScore();
        this.eventEngine.fire('server:game:' + this.id + ':gameEnded', {
            players: this.players
        });
        _.defer(_.bind(this.startGame, this));
    };
    
    this.broadcastGameState = function() {
        this.eventEngine.fire('server:game:' + this.id + ':gameUpdated', this.gameState());
    };

    this.destroy = function() {
        clearInterval(this._cleanupPlayersIntervalId);
    }

    this.getDeck = function() {
        return deck;
    }

    init.apply(this, arguments);
};

Game.prototype.onRegisterPlayer = function(event) {
    this.registerPlayer(event.data.registerId, event.data.secret, event.data.name);
};

Game.prototype.onSelectCards = function(event) {
    var player = this.getPlayer(event.data.playerId);
    if (player) {
        var cards = _.map(event.data.cards, Card.createFromJSON);
        var success = player.selectCards(cards);
        this._sortPlayersByScore();
        if (success) {
            this.eventEngine.fire('server:game:' + this.id + ':playerScored', { player: player, cards: event.data.cards });
            if (player.score >= this.goalScore) {
                this.endGame();
            }
        } else {
            this.eventEngine.fire('server:game:' + this.id + ':playerFailedSet', { player: player, cards: event.data.cards });
        }
        this.eventEngine.fire('server:game:' + this.id + ':gameUpdated', this.gameState());
    }
};

Game.prototype.onStartGame = function(event) {
    var player = this.getPlayer(event.data.playerId);
    if (player) {
        player.isRequestingGameRestart = true;
        if (this.numRestartGameRequests() >= this.restartGameRequestThreshold * this.players.length) {
            this.startGame();
        } else {
            this.broadcastGameState();
        }
    }
};

Game.prototype.onCancelRestartGameRequest = function(event) {
    var player = this.getPlayer(event.data.playerId);
    if (player) {
        player.isRequestingGameRestart = false;
        this.broadcastGameState();
    }
};

Game.prototype.onLeave = function(event) {
    this.removePlayer(event.data.playerId);
    this.eventEngine.fire('server:game:' + this.id + ':gameUpdated', this.gameState());
};

Game.prototype.onStay = function(event) {
    var player = this.getPlayer(event.data.playerId);
    if (player) {
        var now = (new Date()).getTime();
        player.lastSeen = now;
    }
};

Game.prototype.onChangeName = function(event) {
    var player = this.getPlayer(event.data.playerId);
    if (player) {
        var name = event.data.name;
        var regex = /^[\w. ]+$/i; // matches any string of alphanumeric or underscore characters

        if (typeof(name) !== 'string') {
            return;
        }
        if (!name) {
            return;
        }
        if (!regex.test(name)) {
            return;
        }
        var prevName = player.name;
        player.name = name;
        
        this.eventEngine.fire('server:game:' + this.id + ':playerNameChanged', {
            playerId : player.publicId,
            prevName : prevName,
            name : name
        });
        this.eventEngine.fire('server:game:' + this.id + ':gameUpdated', this.gameState());
    }
};

var nextGameId = 1
  , games = {};
Game.create = function(eventEngine) {
    var game = games[nextGameId] = new Game(eventEngine, nextGameId);
    nextGameId++;
    eventEngine.fire('server:game:new', {game: game.gameState()});
    return game;
};
Game.get = function(id) {
    return games[id];
};
Game.list = function() {
    return _.values(games);
};
Game.delete = function(id) {
    var game = Game.get(id),
        gameState = game.gameState(),
        eventEngine = game.eventEngine;
    game.destroy();
    delete games[id];
    eventEngine.fire('server:game:delete', {game: gameState});
};

function cleanupGames() {
    var emptyGames = _.filter(games, function(game) {
        return game.players.length <= 0;
    });
    var now = new Date();
    _.each(emptyGames, function(game) {
        if (game.id !== 1 && now - game.startTime > 30000) {
            Game.delete(game.id);
        }
    });
}

setInterval(cleanupGames, 1000);
